import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ambientWrites, dataWrites, ownWrites, writeOf } from '../src/analysis/index.js';
import { compareFingerprints } from '../src/diff/compare.js';
import { fingerprint } from '../src/diff/fingerprint.js';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';

const span = (kind, name) => ({ kind, name, start: 0, duration: 1, frames: [] });

test('what counts as a write', () => {
  assert.equal(writeOf(span('db', 'update users set seen_at = now() where id = $1')), 'db update users set seen_at = now() where id = $1');
  assert.ok(writeOf(span('db', 'with x as (delete from carts where id = $1 returning *) select * from x')));
  assert.equal(writeOf(span('db', 'select * from users')), null);
  assert.equal(writeOf(span('db', 'begin')), null, 'transaction control is not a write');
  assert.equal(writeOf(span('redis', 'INCR rl:ip:1.2.3.4')), 'redis INCR rl:ip:*');
  assert.equal(writeOf(span('redis', 'GET user:1')), null);
  assert.equal(writeOf(span('redis', 'MULTI')), null);
  assert.equal(writeOf(span('http', 'POST https://api.stripe.com/v1/charges')), 'http POST api.stripe.com');
  assert.equal(writeOf(span('http', 'GET https://api.github.com/users')), null);
});

test('writes on nearly every request across routes are infrastructure', () => {
  const t = (url, ...spans) => ({ method: 'GET', url, spans });
  const rl = span('redis', 'EVAL');
  const traces = [t('/a', rl), t('/b', rl), t('/a', rl), t('/c', rl, span('db', 'insert into views values ($1)')), t('/b', rl)];
  const ambient = ambientWrites(traces);
  assert.deepEqual([...ambient], ['redis EVAL']);
  assert.deepEqual(ownWrites(traces[3], ambient), ['db insert into views values ($1)']);
  assert.equal(ambientWrites(traces.slice(0, 3)).size, 0, 'too few requests to judge');
  // Per-route rate-limit keys and cache fills are Redis writes: not data the read changes.
  const cacheFill = t('/d', span('redis', 'SET catalog:structure:v1'), span('redis', 'EVAL rl:route:d'));
  assert.deepEqual(dataWrites(cacheFill, ambient), []);
  assert.deepEqual(ownWrites(cacheFill, ambient), ['redis SET catalog:structure:*', 'redis EVAL rl:route:*'], 'still listed for measure');
});

test('a read that starts writing is a change; an old baseline without writes is not compared', () => {
  const fp = (spans, ambient) => fingerprint([{ status: 200, duration: 5, spans, shape: null }], ambient);
  const before = fp([span('db', 'select * from users')]);
  const after = fp([span('db', 'select * from users'), span('db', 'update users set seen_at = now()')]);
  const found = compareFingerprints(before, after);
  assert.deepEqual(found[0], { kind: 'changed', what: 'now writes when read: db update users set seen_at = now()' }, 'listed first');
  assert.match(found[1].what, /1 more query/);
  const writesFound = (f) => f.filter((x) => /writes/.test(x.what));
  const { writes, ...legacy } = before;
  assert.deepEqual(writesFound(compareFingerprints(legacy, after)), [], 'a pre-0.7 baseline is not compared on writes');
  const ambient = new Set(['db update users set seen_at = now()']);
  assert.deepEqual(writesFound(compareFingerprints(before, fp([span('db', 'select * from users'), span('db', 'update users set seen_at = now()')], ambient))), [], 'an infrastructure write is not the route changing');
});

const TOKEN = 'e'.repeat(32);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const PG = `class Pool { query() { return new Promise((r) => setTimeout(() => r({ rows: [], rowCount: 0 }), 1)); } }
class Client { query() { return Promise.resolve({ rows: [] }); } }
module.exports = { Pool, Client };`;
// Every request counts a hit (infrastructure); /touch writes on its own; /users starts writing in mode "writes".
const APP = `const http = require('node:http');
const fs = require('node:fs');
const { Pool } = require('pg');
const pool = new Pool();
http.createServer(async (req, res) => {
  await pool.query('insert into hits (path) values ($1)', [req.url]);
  if (req.url.startsWith('/touch')) await pool.query('update users set seen_at = now()');
  if (req.url.startsWith('/users')) {
    await pool.query('select * from users');
    if (fs.readFileSync('mode.txt', 'utf8').trim() === 'writes') await pool.query('update users set seen_at = now()');
  }
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
}).listen(0);`;

test('the diff keeps writing reads out of its baseline, ignores infrastructure writes, and flags a read that starts writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-writes-'));
  mkdirSync(join(root, 'node_modules', 'pg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pg', 'index.js'), PG);
  writeFileSync(join(root, 'app.js'), APP);
  writeFileSync(join(root, 'mode.txt'), 'reads');
  writeFileSync(join(root, 'package.json'), '{"name":"writes-test"}');
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, 'app.js'] });
  server.startApp();
  const session = { port: server.address().port, token: TOKEN };
  try {
    let app;
    for (let i = 0; i < 80 && !(app && app.port); i++) {
      await sleep(100);
      app = await api(session, 'GET', '/api/app?since=999999999');
    }
    for (const p of ['/users', '/health', '/touch', '/users', '/health', '/about']) await fetch(`http://127.0.0.1:${app.port}${p}`);
    await sleep(300);
    const base = await api(session, 'POST', '/api/behavior/diff', {});
    assert.ok(base.created);
    assert.deepEqual(base.captured.sort(), ['GET /about', 'GET /health', 'GET /users'], 'the hit counter on every request does not exclude routes');
    assert.equal(base.skipped.length, 1);
    assert.match(base.skipped[0].why, /changes data when requested \(db update users set seen_at = now\(\)\)/);

    const clean = await api(session, 'POST', '/api/behavior/diff', {});
    assert.deepEqual(clean.results, []);

    writeFileSync(join(root, 'mode.txt'), 'writes');
    const after = await api(session, 'POST', '/api/behavior/diff', {});
    assert.equal(after.results.length, 1);
    assert.equal(after.results[0].route, 'GET /users');
    assert.deepEqual(after.results[0].findings[0], { kind: 'changed', what: 'now writes when read: db update users set seen_at = now()' });
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
