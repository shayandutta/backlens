import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';

const TOKEN = 'a'.repeat(32);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
// Issues JWT-shaped tokens valid for 6 s; /me needs a live one. Optional-auth /feed answers either way.
const APP = `const http = require('node:http');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const live = (h) => { const m = /^Bearer [^.]+\\.([^.]+)\\./.exec(h || ''); if (!m) return false; try { return JSON.parse(Buffer.from(m[1], 'base64url')).exp * 1000 > Date.now(); } catch { return false; } };
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/login') {
      const b = JSON.parse(body || '{}');
      if (b.password !== 'pw123456') { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify({ accessToken: 'h.' + b64({ sub: 1, exp: Math.floor(Date.now() / 1000) + 6 }) + '.s' }));
    }
    if (req.url === '/me') { if (!live(req.headers.authorization)) { res.statusCode = 401; return res.end('{}'); } return res.end('{"id":1,"name":"Ada"}'); }
    res.end(live(req.headers.authorization) ? '{"items":[1],"forYou":true}' : '{"items":[1]}');
  });
}).listen(0);`;

test('an expired recorded JWT is replaced by a fresh sign-in, not reported as a break', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-jwt-'));
  writeFileSync(join(root, 'app.js'), APP);
  writeFileSync(join(root, 'package.json'), '{"name":"jwt-test"}');
  writeFileSync(join(root, '.env'), 'APP_PASSWORD=pw123456\n');
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, 'app.js'] });
  server.startApp();
  const session = { port: server.address().port, token: TOKEN };
  try {
    let app;
    for (let i = 0; i < 80 && !(app && app.port); i++) {
      await sleep(100);
      app = await api(session, 'GET', '/api/app?since=999999999');
    }
    const base = `http://127.0.0.1:${app.port}`;
    const { accessToken } = await (await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"pw123456"}' })).json();
    for (const p of ['/me', '/feed']) await fetch(base + p, { headers: { authorization: `Bearer ${accessToken}` } });
    await sleep(300);
    const { recent } = await api(session, 'GET', '/api/state');
    await api(session, 'POST', '/api/access/save', { name: 'user', id: recent.find((r) => r.method === 'POST').id });
    const signedAt = Date.now();
    const first = await api(session, 'POST', '/api/behavior/diff', {});
    assert.ok(first.created);
    assert.deepEqual(first.captured.sort(), ['GET /feed', 'GET /me']);
    const saved = (await api(session, 'GET', '/api/behavior')).entries;
    assert.equal(saved.find((e) => e.route === 'GET /me').fingerprint.status, 200, 'the baseline was taken while the recorded token was live');
    assert.ok('$.forYou' in saved.find((e) => e.route === 'GET /feed').fingerprint.shape, 'and /feed answered signed in');

    await sleep(Math.max(0, signedAt + 6500 - Date.now())); // the recorded token is now expired
    const after = await api(session, 'POST', '/api/behavior/diff', {});
    assert.deepEqual(after.skipped, []);
    assert.deepEqual(after.results, [], 'no 401 on /me, and /feed did not quietly turn anonymous');
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
