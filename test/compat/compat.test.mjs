import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allAttributed, calls, env, run } from './harness.mjs';

/**
 * The compatibility matrix (`npm run test:compat`): the recorder against real libraries on real
 * Postgres and Redis. Every case checks each call is recorded exactly once, in the right request,
 * with a line of the app's code. The bugs found in real use land here as scenarios first.
 */

const PG_TX = ['begin', 'select 2', 'commit', 'begin', 'select 2', 'commit', 'select 3'];

// The same scenarios, written for each way of reaching Postgres.
const pgApps = {
  pg: `const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.PG_URL, max: 1 });
const routes = {
  '/query': () => pool.query('select 1'),
  '/tx': async () => {
    for (let i = 0; i < 2; i++) {
      const c = await pool.connect();
      try { await c.query('begin'); await c.query('select 2'); await c.query('commit'); } finally { c.release(); }
    }
    await pool.query('select 3');
  },
  '/callback': () => new Promise((res, rej) => pool.query('select 4', (e, r) => (e ? rej(e) : res(r)))),
  '/error': () => pool.query('select * from backlens_compat_missing').catch(() => {}),
  '/parallel': () => Promise.all([pool.query('select 5'), pool.query('select 6')]),
};`,
  drizzle: `const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { sql } = require('drizzle-orm');
const pool = new Pool({ connectionString: process.env.PG_URL, max: 1 });
const db = drizzle(pool);
const routes = {
  '/query': () => db.execute(sql\`select 1\`),
  '/tx': async () => {
    for (let i = 0; i < 2; i++) await db.transaction(async (tx) => { await tx.execute(sql\`select 2\`); });
    await db.execute(sql\`select 3\`);
  },
  '/error': () => db.execute(sql\`select * from backlens_compat_missing\`).catch(() => {}),
  '/parallel': () => Promise.all([db.execute(sql\`select 5\`), db.execute(sql\`select 6\`)]),
};`,
  kysely: `const { Pool } = require('pg');
const { Kysely, PostgresDialect, sql } = require('kysely');
const pool = new Pool({ connectionString: process.env.PG_URL, max: 1 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
const routes = {
  '/query': () => sql\`select 1\`.execute(db),
  '/tx': async () => {
    for (let i = 0; i < 2; i++) await db.transaction().execute(async (trx) => { await sql\`select 2\`.execute(trx); });
    await sql\`select 3\`.execute(db);
  },
  '/error': () => sql\`select * from backlens_compat_missing\`.execute(db).catch(() => {}),
  '/parallel': () => Promise.all([sql\`select 5\`.execute(db), sql\`select 6\`.execute(db)]),
};`,
};

const serve = `
const http = require('node:http');
http.createServer(async (req, res) => {
  try { if (routes[req.url]) await routes[req.url](); } catch (e) { res.statusCode = 500; }
  res.end('ok');
}).listen(0, function () { process.send(this.address().port); });`;

const PG_CASES = [
  { name: 'pg 8.11', app: 'pg', deps: { pg: '8.11.5' } },
  { name: 'pg latest 8', app: 'pg', deps: { pg: '^8' } },
  { name: 'drizzle-orm + pg', app: 'drizzle', deps: { pg: '^8', 'drizzle-orm': '^0' } },
  { name: 'kysely + pg', app: 'kysely', deps: { pg: '^8', kysely: '^0' } },
];

describe('Postgres', { skip: !env.pg && 'PG_URL not set' }, () => {
  for (const c of PG_CASES) {
    test(c.name, async () => {
      const paths = Object.keys({ '/query': 1, '/tx': 1, ...(c.app === 'pg' ? { '/callback': 1 } : {}), '/error': 1, '/parallel': 1 });
      const t = await run({ deps: c.deps, app: pgApps[c.app] + serve, paths });
      assert.deepEqual(calls(t['/query'], 'db'), ['select 1']);
      assert.deepEqual(calls(t['/tx'], 'db'), PG_TX, 'transactions recorded, and the pooled query after them once');
      if (c.app === 'pg') assert.deepEqual(calls(t['/callback'], 'db'), ['select 4']);
      const err = t['/error'].spans.filter((s) => s.kind === 'db');
      assert.equal(err.length, 1);
      assert.equal(err[0].error, true, 'a failing query is marked as an error');
      assert.deepEqual(calls(t['/parallel'], 'db').sort(), ['select 5', 'select 6']);
      for (const p of paths) assert.ok(allAttributed(t[p], 'db'), `every query in ${p} points at the app's code`);
    });
  }
});

const K = 'backlens:compat:k';
const REDIS_CASES = [
  {
    name: 'ioredis 5',
    deps: { ioredis: '^5' },
    app: `const Redis = require('ioredis'); const r = new Redis(process.env.REDIS_URL);
const routes = { '/redis': async () => { await r.set('${K}', 'v'); await r.get('${K}'); await r.pipeline().get('${K}').incr('backlens:compat:n').exec(); await r.multi().get('${K}').exec(); } };`,
    expected: [`SET ${K}`, `GET ${K}`, `GET ${K}`, 'INCR backlens:compat:n', 'MULTI', `GET ${K}`, 'EXEC'],
  },
  ...['^4', '^5'].map((v) => ({
    name: `node-redis ${v.slice(1)}`,
    deps: { redis: v },
    app: `const { createClient } = require('redis'); const r = createClient({ url: process.env.REDIS_URL }); const ready = r.connect();
const routes = { '/redis': async () => { await ready; await r.set('${K}', 'v'); await r.get('${K}'); await r.multi().get('${K}').incr('backlens:compat:n').exec(); } };`,
    expected: [`SET ${K}`, `GET ${K}`, 'MULTI', `GET ${K}`, 'INCR backlens:compat:n', 'EXEC'],
  })),
];

describe('Redis', { skip: !env.redis && 'REDIS_URL not set' }, () => {
  for (const c of REDIS_CASES) {
    test(c.name, async () => {
      const t = await run({ deps: c.deps, app: c.app + serve, paths: ['/redis'] });
      assert.deepEqual(calls(t['/redis'], 'redis'), c.expected, 'every command once, pipelines and MULTI included');
      assert.ok(allAttributed(t['/redis'], 'redis'), "every command points at the app's code");
    });
  }
});

// Route templates: the route as written (/users/:id), not each URL, so requests group correctly.
const FRAMEWORK_CASES = [
  ...['^4', '^5'].map((v) => ({
    name: `express ${v.slice(1)}`,
    deps: { express: v },
    app: `const express = require('express'); const app = express();
app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
const s = app.listen(0, () => process.send(s.address().port));`,
  })),
  ...['^4', '^5'].map((v) => ({
    name: `fastify ${v.slice(1)}`,
    deps: { fastify: v },
    app: `const app = require('fastify')();
app.get('/users/:id', async (req) => ({ id: req.params.id }));
app.listen({ port: 0, host: '127.0.0.1' }).then(() => process.send(app.server.address().port));`,
  })),
];

describe('Frameworks', () => {
  for (const c of FRAMEWORK_CASES) {
    test(c.name, async () => {
      const t = await run({ deps: c.deps, app: c.app, paths: ['/users/42', '/users/43'] });
      assert.equal(t['/users/42'].template, '/users/:id');
      assert.equal(t['/users/43'].template, '/users/:id');
      assert.equal(t['/users/42'].status, 200);
    });
  }
});

describe('Queues', { skip: !env.redis && 'REDIS_URL not set' }, () => {
  test('bullmq 5: the request shows what it queued; the job run is its own trace, linked by id', async () => {
    const q = `backlens-compat-${Date.now()}`;
    const app = `const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('${q}', { connection });
const reader = new IORedis(process.env.REDIS_URL);
let done;
const ran = new Promise((r) => (done = r));
new Worker('${q}', async (job) => { await reader.get('backlens:compat:job:' + job.data.n); done(); }, { connection: new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) });
const routes = { '/enqueue': async () => { await queue.add('welcome', { n: 1 }, { removeOnComplete: true }); await ran; } };` + serve;
    const t = await run({ deps: { bullmq: '^5', ioredis: '^5' }, app, paths: ['/enqueue'] });
    const req = t['/enqueue'];
    const enq = req.spans.find((s) => s.kind === 'job');
    assert.ok(enq, 'the enqueue is a span of the request');
    assert.equal(enq.name, `ENQUEUE ${q}:welcome`);
    assert.ok(enq.job && enq.job.id, 'with the job id');
    assert.ok(enq.frames.some((f) => f.file === 'app.js'), 'and the code line that queued it');
    const run1 = t[`/${q}/welcome`];
    assert.ok(run1, 'the job run is a trace of its own');
    assert.equal(run1.method, 'JOB');
    assert.equal(run1.job.id, enq.job.id, 'linked to the request by job id');
    assert.equal(run1.status, 200);
    assert.deepEqual(calls(run1, 'redis'), ['GET backlens:compat:job:1'], "the job's own calls are recorded in its trace");
  });
});
