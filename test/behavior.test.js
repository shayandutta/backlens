import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';

const TOKEN = 'b'.repeat(32);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// A tiny app whose behavior follows mode.txt, read on every request: ok, lost (a field gone), fail (500).
const APP = `const http = require('node:http');
const fs = require('node:fs');
http.createServer((req, res) => {
  const mode = fs.readFileSync('mode.txt', 'utf8').trim();
  if (req.url.startsWith('/users/')) {
    if (mode === 'fail') { res.statusCode = 500; return res.end('{"error":"boom"}'); }
    const user = { id: 1, name: 'Ada', email: 'ada@example.com', tags: ['a'] };
    if (mode === 'lost') delete user.email;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(user));
  }
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
}).listen(0);`;

test('the behavior diff takes a baseline, stays quiet, and catches a lost field and a 500', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-behavior-'));
  writeFileSync(join(root, 'app.js'), APP);
  writeFileSync(join(root, 'mode.txt'), 'ok');
  writeFileSync(join(root, 'package.json'), '{"name":"behavior-test"}');
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, 'app.js'] });
  server.startApp();
  const session = { port: server.address().port, token: TOKEN };
  try {
    let app;
    for (let i = 0; i < 80 && !(app && app.port); i++) {
      await sleep(100);
      app = await api(session, 'GET', '/api/app?since=999999999');
    }
    assert.ok(app.port, 'the app reported its port');
    for (const p of ['/users/1', '/health']) await fetch(`http://127.0.0.1:${app.port}${p}`, { headers: { authorization: 'Bearer secret-token' } });
    await sleep(300);

    const first = await api(session, 'POST', '/api/behavior/diff', {});
    assert.equal(first.created, true);
    assert.deepEqual(first.captured.sort(), ['GET /health', 'GET /users/:id']);
    const saved = readFileSync(join(root, '.backlens', 'behavior.json'), 'utf8');
    assert.ok(!saved.includes('secret-token') && !saved.includes('ada@'), 'no headers or values on disk');
    assert.equal(statSync(join(root, '.backlens', 'behavior.json')).mode & 0o777, 0o600);

    const clean = await api(session, 'POST', '/api/behavior/diff', {});
    assert.equal(clean.checked, 2);
    assert.deepEqual(clean.results, []);

    writeFileSync(join(root, 'mode.txt'), 'lost');
    const lost = await api(session, 'POST', '/api/behavior/diff', {});
    assert.equal(lost.broken, 1);
    assert.deepEqual(lost.results, [{ route: 'GET /users/:id', findings: [{ kind: 'broken', what: 'response lost $.email' }] }]);

    writeFileSync(join(root, 'mode.txt'), 'fail');
    const fail = await api(session, 'POST', '/api/behavior/diff', {});
    assert.match(fail.results[0].findings[0].what, /answers 500 \(was 200\)/);

    // The dashboard's Diff tab reads the last result and the baseline's size.
    const shown = await api(session, 'GET', '/api/behavior/last');
    assert.equal(shown.baseline.routes, 2);
    assert.equal(shown.last.results[0].route, 'GET /users/:id');

    // An intended change, accepted: the next diff compares with it, and it leaves the list.
    await api(session, 'POST', '/api/behavior/accept', { routes: ['GET /users/:id'] });
    assert.deepEqual((await api(session, 'GET', '/api/behavior/last')).last.results, []);
    const after = await api(session, 'POST', '/api/behavior/diff', {});
    assert.deepEqual(after.results, []);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
