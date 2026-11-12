import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';

const TOKEN = 'd'.repeat(32);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// A stand-in pg, and an app whose route reads the same row twice until mode.txt says "fixed".
const PG = `class Pool { query(text, values) { return new Promise((r) => setTimeout(() => r({ rows: [{ id: 1 }], rowCount: 1 }), 1)); } }
class Client { query() { return Promise.resolve({ rows: [] }); } }
module.exports = { Pool, Client };`;
const APP = `const http = require('node:http');
const fs = require('node:fs');
const { Pool } = require('pg');
const pool = new Pool();
async function loadUser() { return pool.query('select * from users where id = $1', [1]); }
async function page() {
  await loadUser();
  if (fs.readFileSync('mode.txt', 'utf8').trim() !== 'fixed') await loadUser();
}
http.createServer(async (req, res) => { await page(); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }).listen(0);`;

test('an issue fixed outside the dashboard leaves the list once a replay of the new code shows it gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-stale-'));
  mkdirSync(join(root, 'node_modules', 'pg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pg', 'index.js'), PG);
  writeFileSync(join(root, 'app.js'), APP);
  writeFileSync(join(root, 'mode.txt'), 'broken');
  writeFileSync(join(root, 'package.json'), '{"name":"stale-test"}');
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, 'app.js'] });
  server.startApp();
  const session = { port: server.address().port, token: TOKEN };
  try {
    let app;
    for (let i = 0; i < 80 && !(app && app.port); i++) {
      await sleep(100);
      app = await api(session, 'GET', '/api/app?since=999999999');
    }
    await fetch(`http://127.0.0.1:${app.port}/page`);
    await sleep(300);
    const before = await api(session, 'GET', '/api/state');
    assert.equal(before.issues.filter((i) => i.type === 'repeat').length, 1, 'the repeat is listed');

    // Someone (an agent, an editor) fixes the code; the dashboard was not involved.
    writeFileSync(join(root, 'mode.txt'), 'fixed');
    const m = await api(session, 'POST', '/api/measure', { id: before.recent[0].id, runs: 2 });
    assert.equal(m.now.queries, 1);
    const after = await api(session, 'GET', '/api/state');
    assert.deepEqual(after.issues.filter((i) => i.type === 'repeat'), [], 'the stale issue is gone from the list');

    // And a new request that shows it again brings it back.
    writeFileSync(join(root, 'mode.txt'), 'broken');
    await fetch(`http://127.0.0.1:${app.port}/page`);
    await sleep(300);
    const again = await api(session, 'GET', '/api/state');
    assert.equal(again.issues.filter((i) => i.type === 'repeat').length, 1);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
