import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';

const TOKEN = 'b'.repeat(32);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
// A stand-in pg that keeps a log of statements per connection, so the test can see what ran where.
const PG = `const log = (global.__pgLog = global.__pgLog || []);
class Client { constructor(id) { this.id = id; } query(c) { const text = typeof c === 'string' ? c : c.text; log.push(this.id + ': ' + text); return Promise.resolve({ rows: [], rowCount: 1 }); } release() {} connect() { return Promise.resolve(); } }
let n = 0;
class Pool {
  connect(cb) { const c = new Client('pool' + ++n); if (cb) { setImmediate(() => cb(null, c, () => {})); return; } return Promise.resolve(c); }
  query(text) { return new Promise((resolve) => this.connect((e, c) => c.query(text).then(resolve))); }
}
module.exports = { Pool, Client };`;
// POST /orders inserts; mode "broken" makes it fail; mode "leak" also writes on a client of its own.
const APP = `const http = require('node:http');
const fs = require('node:fs');
const { Pool, Client } = require('pg');
const pool = new Pool();
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  res.setHeader('content-type', 'application/json');
  const mode = fs.readFileSync('mode.txt', 'utf8').trim();
  if (req.method === 'POST' && req.url === '/orders') {
    if (mode === 'broken') { res.statusCode = 500; return res.end('{"error":"x"}'); }
    await pool.query('insert into orders (item) values ($1)');
    if (mode === 'leak') { const own = new Client('own'); await own.query('insert into audit values (1)'); }
    res.statusCode = 201;
    return res.end('{"id":1,"item":"book"}');
  }
  await pool.query('select * from orders');
  res.end('{"items":[]}');
}).listen(0);`;

test('diff replays recorded writes in the rolled-back sandbox, catches a break, and stops on a leak', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-diff-writes-'));
  mkdirSync(join(root, 'node_modules', 'pg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pg', 'index.js'), PG);
  writeFileSync(join(root, 'app.js'), APP);
  writeFileSync(join(root, 'mode.txt'), 'ok');
  writeFileSync(join(root, 'package.json'), '{"name":"diff-writes-test"}');
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
    await fetch(`${base}/orders`);
    await fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"item":"book"}' });
    await sleep(300);

    const first = await api(session, 'POST', '/api/behavior/diff', {});
    assert.deepEqual(first.captured.sort(), ['GET /orders', 'POST /orders'], 'the write is in the baseline');
    const clean = await api(session, 'POST', '/api/behavior/diff', {});
    assert.deepEqual(clean.results, []);
    assert.deepEqual(clean.skipped, []);

    writeFileSync(join(root, 'mode.txt'), 'broken');
    const broken = await api(session, 'POST', '/api/behavior/diff', {});
    assert.deepEqual(broken.results.map((r) => [r.route, r.findings[0].what]), [['POST /orders', 'answers 500 (was 201)']]);

    writeFileSync(join(root, 'mode.txt'), 'leak');
    const leak = await api(session, 'POST', '/api/behavior/diff', {});
    assert.equal(leak.skipped.length, 1);
    assert.match(leak.skipped[0].why, /WARNING: the write sandbox did not hold \(\d+ queries ran outside the rolled-back transaction\)/);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
