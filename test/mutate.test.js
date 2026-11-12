import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';
import { mutationText } from '../src/mutate/format.js';

const TOKEN = 'c'.repeat(32);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const PG = `class Pool { query() { return new Promise((r) => setTimeout(() => r({ rows: [], rowCount: 0 }), 1)); } }
class Client { query() { return Promise.resolve({ rows: [] }); } }
module.exports = { Pool, Client };`;
const APP = `const http = require('node:http');
const { Pool } = require('pg');
const pool = new Pool();
function deny(res, code) { res.statusCode = code; return res.end('{"error":true}'); }
async function admin(req, res) {
  if (req.headers['x-role'] !== 'admin') return deny(res, 403);
  await pool.query('select * from users');
  res.setHeader('content-type', 'application/json');
  return res.end('{"users":[{"id":1}]}');
}
http.createServer((req, res) => (req.url.startsWith('/admin') ? admin(req, res) : res.end('{}'))).listen(0);
`;

test('the lab finds a guard nothing exercises, and puts the file back exactly', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-mutate-'));
  mkdirSync(join(root, 'node_modules', 'pg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pg', 'index.js'), PG);
  writeFileSync(join(root, 'app.js'), APP);
  writeFileSync(join(root, 'package.json'), '{"name":"mutate-test"}');
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, 'app.js'] });
  server.startApp();
  const session = { port: server.address().port, token: TOKEN };
  try {
    let app;
    for (let i = 0; i < 80 && !(app && app.port); i++) {
      await sleep(100);
      app = await api(session, 'GET', '/api/app?since=999999999');
    }
    // Only the admin path is ever used: nothing exercises the denial.
    await fetch(`http://127.0.0.1:${app.port}/admin`, { headers: { 'x-role': 'admin' } });
    await sleep(300);
    const r = await api(session, 'POST', '/api/mutate', { tests: false });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].verdict, 'not caught');
    assert.match(mutationText(r), /NOT CAUGHT\s+app\.js:6\s+removed the check `if \(req\.headers\['x-role'\] !== 'admin'\)`/);
    assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), APP, 'file restored byte for byte');
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same guard is caught once a refused request is recorded', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-mutate2-'));
  mkdirSync(join(root, 'node_modules', 'pg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pg', 'index.js'), PG);
  writeFileSync(join(root, 'app.js'), APP);
  writeFileSync(join(root, 'package.json'), '{"name":"mutate-test-2"}');
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, 'app.js'] });
  server.startApp();
  const session = { port: server.address().port, token: TOKEN };
  try {
    let app;
    for (let i = 0; i < 80 && !(app && app.port); i++) {
      await sleep(100);
      app = await api(session, 'GET', '/api/app?since=999999999');
    }
    await fetch(`http://127.0.0.1:${app.port}/admin`, { headers: { 'x-role': 'admin' } });
    await fetch(`http://127.0.0.1:${app.port}/admin`); // refused: 403, and the newest for the route
    await sleep(300);
    const r = await api(session, 'POST', '/api/mutate', { tests: false });
    assert.equal(r.results[0].verdict, 'caught');
    assert.match(r.results[0].detail.join(), /answers 200 \(was 403\): a request that was refused now gets through/);
    assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), APP);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
