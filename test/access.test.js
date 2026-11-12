import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fillTemplate, parseEnv } from '../src/access/env.js';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';

test('.env parsing and ${env:NAME} templates', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two words"\nC=x # note\n'), { A: '1', B: 'two words', C: 'x' });
  assert.equal(fillTemplate('{"p":"${env:A}"}', { A: 's3cret' }), '{"p":"s3cret"}');
  assert.throws(() => fillTemplate('${env:NOPE}', {}), /NOPE is not set/);
});

const TOKEN = 'c'.repeat(32);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
// An app with a JSON login that hands back a token, and a route that needs it.
const APP = `const http = require('node:http');
const TOKEN = 'tok-' + Math.random().toString(36).slice(2);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/login') {
      const b = JSON.parse(body || '{}');
      if (b.email === 'admin@example.com' && b.password === 'hunter22') return res.end(JSON.stringify({ accessToken: TOKEN }));
      res.statusCode = 401; return res.end('{}');
    }
    if (req.url === '/me') {
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.statusCode = 401; return res.end('{}'); }
      return res.end('{"id":1,"role":"admin"}');
    }
    res.end('{"ok":true}');
  });
}).listen(0);`;

async function withApp(env, fn) {
  const root = mkdtempSync(join(tmpdir(), 'backlens-access-'));
  writeFileSync(join(root, 'app.js'), APP);
  writeFileSync(join(root, 'package.json'), '{"name":"access-test"}');
  writeFileSync(join(root, '.env'), env);
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, 'app.js'] });
  server.startApp();
  const session = { port: server.address().port, token: TOKEN };
  try {
    let app;
    for (let i = 0; i < 80 && !(app && app.port); i++) {
      await sleep(100);
      app = await api(session, 'GET', '/api/app?since=999999999');
    }
    const login = await fetch(`http://127.0.0.1:${app.port}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'hunter22' }) });
    assert.equal(login.status, 200);
    await sleep(300);
    const { recent } = await api(session, 'GET', '/api/state');
    await fn({ root, session, loginId: recent.find((r) => r.method === 'POST').id });
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a saved login keeps .env references, never the password, and signs in for measure', async () => {
  await withApp('ADMIN_EMAIL=admin@example.com\nADMIN_PASSWORD=hunter22\n', async ({ root, session, loginId }) => {
    const saved = await api(session, 'POST', '/api/access/save', { name: 'admin', id: loginId });
    assert.equal(saved.signedIn, true);
    assert.equal(saved.sessionOnly, false);
    const file = readFileSync(join(root, '.backlens', 'profiles.json'), 'utf8');
    assert.ok(!file.includes('hunter22') && file.includes('${env:ADMIN_PASSWORD}') && file.includes('${env:ADMIN_EMAIL}'));
    assert.equal(statSync(join(root, '.backlens', 'profiles.json')).mode & 0o777, 0o600);
    assert.equal(saved.default, 'admin');

    const plain = await api(session, 'POST', '/api/measure', { url: '/me', runs: 2 }).catch((e) => e.message);
    assert.match(String(plain.now ? plain.now.status : plain), /401/);
    const signed = await api(session, 'POST', '/api/measure', { url: '/me', runs: 2, as: 'admin' });
    assert.equal(signed.now.status, 200);
    assert.equal(signed.as, 'admin');
    assert.ok(!JSON.stringify(signed).includes('tok-'), 'the token stays inside backlens');

    // A recorded signed-in request whose token died with an app restart: the diff signs in as
    // the saved role instead of calling the route broken, and accept never stores the 401.
    const { port } = await api(session, 'GET', '/api/app?since=999999999');
    await fetch(`http://127.0.0.1:${port}/me`, { headers: { authorization: `Bearer ${(await (await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'hunter22' }) })).json()).accessToken}` } });
    await sleep(300);
    const base = await api(session, 'POST', '/api/behavior/diff', {});
    assert.ok(base.created && base.captured.includes('GET /me'));
    await api(session, 'POST', '/api/app/restart');
    await sleep(1500);
    const after = await api(session, 'POST', '/api/behavior/diff', {});
    assert.deepEqual(after.results, [], 'no 401 reported: the role was used');
    assert.equal(after.checked, base.captured.length);
  });
});

test('a password in no .env file is kept for the session only, never written', async () => {
  await withApp('OTHER=1\n', async ({ root, session, loginId }) => {
    const saved = await api(session, 'POST', '/api/access/save', { name: 'admin', id: loginId });
    assert.equal(saved.sessionOnly, true);
    assert.deepEqual(saved.missing, ['password']);
    assert.equal(saved.signedIn, true);
    let onDisk = '';
    try {
      onDisk = readFileSync(join(root, '.backlens', 'profiles.json'), 'utf8');
    } catch {}
    assert.ok(!onDisk.includes('hunter22'));
  });
});
