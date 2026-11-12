import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'recorder', 'index.cjs');

/**
 * Runs a tiny app whose handler lives in a bundled chunk with an external source map, the way
 * Next.js with Turbopack ships code, and returns the traces the recorder sends.
 */
async function record(paths, files = {}, main = 'server.js') {
  const dir = mkdtempSync(join(tmpdir(), 'backlens-register-'));
  mkdirSync(join(dir, '.next'));
  // Line 3 of the chunk maps to line 10 of src/app.ts.
  writeFileSync(
    join(dir, '.next', 'chunk.js'),
    ['// generated', 'module.exports = async function handler(url) {', '  return await fetch(url);', '};', '//# sourceMappingURL=chunk.js.map', ''].join('\n'),
  );
  writeFileSync(
    join(dir, '.next', 'chunk.js.map'),
    JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ['../src/app.ts'], names: [], mappings: ';;AASA' } }] }),
  );
  writeFileSync(
    join(dir, 'server.js'),
    `const http = require('node:http');
const handler = require('./.next/chunk.js');
const server = http.createServer(async (req, res) => {
  if (req.url === '/ping') return res.end('pong');
  if (req.url === '/call') await handler('http://127.0.0.1:' + server.address().port + '/ping');
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`,
  );

  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }

  const traces = [];
  const sink = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      if (req.url === '/ingest') traces.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--require', REGISTER, main], {
    cwd: dir,
    env: { ...process.env, BACKLENS_URL: `http://127.0.0.1:${sink.address().port}`, BACKLENS_ROOT: dir, BACKLENS_TOKEN: 't', NODE_OPTIONS: '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    const port = await new Promise((r) => child.once('message', r));
    for (const p of paths) await (await fetch(`http://127.0.0.1:${port}${p}`)).text();
    await new Promise((r) => setTimeout(r, 300));
    return traces;
  } finally {
    child.kill();
    sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('calls from bundled chunks point at the original source through the source map', async () => {
  const traces = await record(['/call']);
  const call = traces.find((t) => t.url === '/call');
  assert.ok(call, 'the request was recorded');
  const span = call.spans.find((s) => s.kind === 'http');
  assert.ok(span, 'the fetch was recorded');
  assert.deepEqual(span.frames[0], { fn: 'handler', file: 'src/app.ts', line: 10 });
});

test('framework asset requests are not recorded', async () => {
  const traces = await record(['/_next/static/chunks/a.js', '/favicon.ico', '/app.js.map', '/ping']);
  assert.deepEqual(traces.map((t) => t.url), ['/ping']);
});

test('outgoing http.get is recorded once with its status, and fetch is not counted twice', async () => {
  const app = `const http = require('node:http');
const server = http.createServer(async (req, res) => {
  const base = 'http://127.0.0.1:' + server.address().port;
  if (req.url.startsWith('/ping')) return res.end('pong');
  await new Promise((ok) => http.get(base + '/ping?x=1', (r) => { r.resume(); r.on('end', ok); }));
  await (await fetch(base + '/ping')).text();
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/both'], { 'out.js': app }, 'out.js');
  const spans = traces.find((t) => t.url === '/both').spans.filter((s) => s.kind === 'http');
  assert.equal(spans.length, 2);
  assert.match(spans[0].name, /^GET 127\.0\.0\.1:\d+\/ping$/, 'no query string in the label');
  assert.equal(spans[0].status, 200);
  assert.deepEqual(spans[0].frames[0], { fn: '(anonymous)', file: 'out.js', line: 5 });
});

test('ESM named imports of node:http are recorded too', async () => {
  const app = `import { createServer, get } from 'node:http';
const server = createServer(async (req, res) => {
  if (req.url === '/ping') return res.end('pong');
  await new Promise((ok) => get('http://127.0.0.1:' + server.address().port + '/ping', (r) => { r.resume(); r.on('end', ok); }));
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/esm'], { 'esm.mjs': app }, 'esm.mjs');
  assert.equal(traces.find((t) => t.url === '/esm').spans.filter((s) => s.kind === 'http').length, 1);
});

test('node-redis commands are recorded through its queue, and AUTH never shows its argument', async () => {
  // The same shape as @redis/client's dist/lib/client/commands-queue.js.
  const queue = `class RedisCommandsQueue {
  addCommand(args) { return Promise.resolve(args[0] === 'GET' ? null : 'OK'); }
}
exports.default = RedisCommandsQueue;`;
  const app = `const http = require('node:http');
const Queue = require('./lib/commands-queue').default;
const q = new Queue();
const server = http.createServer(async (req, res) => {
  await q.addCommand(['AUTH', 'hunter2-password']);
  await q.addCommand(['GET', 'session:abc']);
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/r'], { 'lib/commands-queue.js': queue, 'redis-app.js': app }, 'redis-app.js');
  const spans = traces.find((t) => t.url === '/r').spans;
  assert.deepEqual(spans.map((s) => s.name), ['AUTH', 'GET session:abc']);
  assert.equal(spans[1].hit, false);
  assert.ok(!JSON.stringify(traces).includes('hunter2'));
});

test('Prisma engine queries are recorded with the app line and argument hashes, never the values', async () => {
  // Shaped like Prisma 6 on its Rust engine: lazy promises built per instance, the operation run
  // on a later tick, and the SQL reported to the global tracing helper afterwards.
  const prisma = `class PrismaClient {
  constructor() {
    this._createPrismaPromise = (callback) => ({ then: (ok, fail) => new Promise((r) => setImmediate(r)).then(() => callback()).then(ok, fail) });
    this.user = { findUnique: (args) => this._createPrismaPromise(() => this._request({ model: 'User', action: 'findUnique', args })) };
  }
  async _request() {
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 2));
    const helper = globalThis.PRISMA_INSTRUMENTATION && globalThis.PRISMA_INSTRUMENTATION.helper;
    if (helper && helper.isEnabled()) {
      const t = (ms) => [Math.floor(ms / 1000), (ms % 1000) * 1e6];
      helper.dispatchEngineSpans([{ name: 'prisma:engine:db_query', startTime: t(started), endTime: t(Date.now()), attributes: { 'db.query.text': 'SELECT "name" FROM "User" WHERE "id" = $1 LIMIT $2' } }]);
    }
    return { name: 'someone' };
  }
}
exports.PrismaClient = PrismaClient;`;
  const app = `const http = require('node:http');
const { PrismaClient } = require('./generated/prisma/client');
const db = new PrismaClient();
const server = http.createServer(async (req, res) => {
  for (const id of [101, 102, 103]) await db.user.findUnique({ where: { id, email: 'secret@example.com' } });
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/p'], { 'generated/prisma/client.js': prisma, 'prisma-app.js': app }, 'prisma-app.js');
  const spans = traces.find((t) => t.url === '/p').spans.filter((s) => s.kind === 'db');
  assert.equal(spans.length, 3);
  assert.deepEqual(spans[0].frames[0], { fn: 'Server.<anonymous>', file: 'prisma-app.js', line: 5 });
  assert.equal(new Set(spans.map((s) => s.params)).size, 3, 'each call is told apart by its arguments');
  assert.ok(!JSON.stringify(traces).includes('secret@example.com'));
});

test('a wrapper around pool.query that does not await is skipped for the code that awaited it', async () => {
  // A stand-in pg, an ORM that calls it on a later tick (like drizzle), and an app helper that
  // wraps pool.query and returns its promise without awaiting it (a timing helper, say).
  const pg = `class Pool { query(text) { return new Promise((r) => setTimeout(() => r({ rows: [], rowCount: 0 }), 1)); } }
class Client { query() { return Promise.resolve({ rows: [] }); } }
module.exports = { Pool, Client };`;
  const orm = `module.exports = (pool) => ({ run: async (text) => { await null; return pool.query(text); } });`;
  const wrapper = `module.exports = function timePool(pool) {
  const query = pool.query.bind(pool);
  pool.query = (...args) => query(...args);
};`;
  const app = `const http = require('node:http');
const { Pool } = require('pg');
const pool = new Pool();
require('./src/timing')(pool);
const db = require('orm')(pool);
async function listUsers() {
  const rows = await db.run('select 1 from users');
  return rows;
}
const server = http.createServer(async (req, res) => {
  await listUsers();
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/w'], { 'node_modules/pg/index.js': pg, 'node_modules/orm/index.js': orm, 'src/timing.js': wrapper, 'wrapped.js': app }, 'wrapped.js');
  const span = traces.find((t) => t.url === '/w').spans.find((s) => s.kind === 'db');
  assert.equal(span.frames[0].fn, 'listUsers');
  assert.equal(span.frames[0].file, 'wrapped.js');
});

test('queries an ORM runs on a client the app leased (a transaction) are recorded once', async () => {
  // A stand-in pg whose pool.query connects for itself, like pg-pool, and an ORM in node_modules
  // that drives a leased client from microtasks: no app code on the stack when it queries.
  const pg = `class Client { query(text) { return Promise.resolve({ rows: [], rowCount: 0 }); } release() {} }
class Pool {
  connect(cb) { const c = new Client(); if (cb) { cb(null, c, () => c.release()); return; } return Promise.resolve(c); }
  query(text) { return new Promise((resolve) => this.connect((err, c, done) => c.query(text).then((r) => { done(); resolve(r); }))); }
}
module.exports = { Pool, Client };`;
  // Queries are issued from setImmediate callbacks: the async stack (and any app frame) is lost,
  // as with drizzle on node-postgres, but the request's context still flows.
  const orm = `const later = (fn) => new Promise((resolve, reject) => setImmediate(() => fn().then(resolve, reject)));
module.exports = (pool) => ({
  transaction: async (fn) => {
    const c = await later(() => pool.connect());
    await later(() => c.query('BEGIN'));
    try { await fn({ run: (t) => later(() => c.query(t)) }); await later(() => c.query('COMMIT')); } finally { c.release(); }
  },
});`;
  const app = `const http = require('node:http');
const { Pool } = require('pg');
const pool = new Pool();
const db = require('orm')(pool);
const server = http.createServer(async (req, res) => {
  if (req.url === '/tx') await db.transaction((tx) => tx.run('insert into t values (1)'));
  else if (req.url === '/own') await pool.query({ text: 'select 9', __backlens: true });
  else await pool.query('select 1 from t');
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/tx', '/q', '/own'], { 'node_modules/pg/index.js': pg, 'node_modules/orm/index.js': orm, 'tx.js': app }, 'tx.js');
  const db = (url) => traces.find((t) => t.url === url).spans.filter((s) => s.kind === 'db').map((s) => s.name);
  assert.deepEqual(db('/tx'), ['BEGIN', 'insert into t values (1)', 'COMMIT']);
  assert.deepEqual(db('/q'), ['select 1 from t'], 'pool.query is counted once, not again for its own connect');
  assert.deepEqual(db('/own'), [], "backlens's own tagged queries (the index advisor) are never recorded");
});

test('a pooled client reused after a transaction is not counted twice (pg-pool reassigns release)', async () => {
  // Like pg-pool: one client, handed out again and again, with a fresh release() on every acquire;
  // pool.query connects for itself and queries from its callback, later.
  const pg = `class Client { query(text) { return Promise.resolve({ rows: [], rowCount: 0 }); } }
const shared = new Client();
class Pool {
  connect(cb) {
    const c = shared;
    c.release = () => {};
    if (cb) { setImmediate(() => cb(null, c, () => c.release())); return; }
    return new Promise((r) => setImmediate(() => r(c)));
  }
  query(text) { return new Promise((resolve) => this.connect((err, c, done) => c.query(text).then((r) => { done(); resolve(r); }))); }
}
module.exports = { Pool, Client };`;
  const orm = `const later = (fn) => new Promise((resolve, reject) => setImmediate(() => fn().then(resolve, reject)));
module.exports = (pool) => ({
  transaction: async (fn) => {
    const c = await later(() => pool.connect());
    await later(() => c.query('BEGIN'));
    try { await fn({ run: (t) => later(() => c.query(t)) }); await later(() => c.query('COMMIT')); } finally { c.release(); }
  },
});`;
  const app = `const http = require('node:http');
const { Pool } = require('pg');
const pool = new Pool();
const db = require('orm')(pool);
const server = http.createServer(async (req, res) => {
  await db.transaction((tx) => tx.run('update orders set paid = true'));
  await db.transaction((tx) => tx.run('insert into audit values (1)'));
  await pool.query('select * from orders where id = 1');
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/pay'], { 'node_modules/pg/index.js': pg, 'node_modules/orm/index.js': orm, 'pay.js': app }, 'pay.js');
  const spans = traces.find((t) => t.url === '/pay').spans.filter((s) => s.kind === 'db');
  assert.deepEqual(spans.map((s) => s.name), ['BEGIN', 'update orders set paid = true', 'COMMIT', 'BEGIN', 'insert into audit values (1)', 'COMMIT', 'select * from orders where id = 1']);
  assert.ok(spans.at(-1).frames.length, 'the pool.query span keeps its code line');
});

test('value hashes are keyed per process, so they cannot be matched against guessed values', () => {
  const privacy = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'recorder', 'privacy.cjs');
  const hash = () => execFileSync(process.execPath, ['-e', `const p = require(${JSON.stringify(privacy)}); console.log(p.hashValues(['ada@example.com']), p.hashValues(['ada@example.com']))`], { encoding: 'utf8' }).trim().split(' ');
  const [a1, a2] = hash();
  const [b1] = hash();
  assert.equal(a1, a2, 'stable within a process, so repeats are still found');
  assert.notEqual(a1, b1, 'different in another process');
  assert.notEqual(a1, createHash('sha1').update(JSON.stringify(['ada@example.com'])).digest('hex').slice(0, 12), 'not the plain hash anyone can compute');
});
