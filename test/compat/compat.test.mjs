import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { tally, raceFindings } from '../../src/race/verdict.js';
import { allAttributed, calls, env, run, runWith } from './harness.mjs';

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

describe('Concurrency probes', { skip: !env.pg && 'PG_URL not set' }, () => {
  test('a check-then-decrement is caught racing; the atomic version is not; the database ends as it started', async () => {
    const T = `backlens_compat_stock_${process.pid}`;
    const app = `const http = require('node:http');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.PG_URL, max: 4 });
const ready = pool.query('create table if not exists ${T} (id int primary key, qty int not null)').then(() => pool.query('insert into ${T} values (1, 1) on conflict (id) do update set qty = 1'));
const routes = {
  '/buy-racy': async () => {
    const { rows } = await pool.query('select qty from ${T} where id = 1');
    if (rows[0].qty < 1) return 409;
    await pool.query('update ${T} set qty = qty - 1 where id = 1');
    return 200;
  },
  '/buy-atomic': async () => ((await pool.query('update ${T} set qty = qty - 1 where id = 1 and qty > 0')).rowCount ? 200 : 409),
  '/qty': async () => 200 + (await pool.query('select qty from ${T} where id = 1')).rows[0].qty,
  '/drop': async () => (await pool.query('drop table ${T}'), 200),
};
http.createServer(async (req, res) => {
  await ready;
  try { res.statusCode = await routes[req.url](); } catch (e) { res.statusCode = 500; }
  res.end();
}).listen(0, function () { process.send(this.address().port); });`;
    const sets = {};
    let qtyAfter = null;
    const drive = async (port) => {
      const send = (path, group) => {
        const id = randomUUID();
        (sets[group.name] ||= []).push(id);
        return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'x-backlens-replay': id, 'x-backlens-sandbox': `group:${group.id}:5` } }).then((r) => r.text());
      };
      for (const path of ['/buy-racy', '/buy-atomic']) {
        const seq = { name: `${path} seq`, id: randomUUID() };
        for (let i = 0; i < 5; i++) await send(path, seq);
        const conc = { name: `${path} conc`, id: randomUUID() };
        await Promise.all(Array.from({ length: 5 }, () => send(path, conc)));
      }
      await new Promise((r) => setTimeout(r, 300));
      qtyAfter = (await fetch(`http://127.0.0.1:${port}/qty`)).status - 200;
      await fetch(`http://127.0.0.1:${port}/drop`);
    };
    const traces = await runWith({ deps: { pg: '^8' }, app, drive });
    const of = (name) => traces.filter((t) => sets[name].includes(t.replayOf));
    for (const name of Object.keys(sets)) {
      const final = of(name).map((t) => t.sandbox).filter((s) => s && s.final);
      assert.equal(final.length, 1, `${name}: one copy reports the rollback`);
      assert.deepEqual([final[0].rolledBack, final[0].leaked], [true, 0], `${name}: rolled back, nothing outside`);
    }
    const racy = raceFindings(tally(of('/buy-racy seq')), tally(of('/buy-racy conc')));
    assert.deepEqual([tally(of('/buy-racy seq')).ok, tally(of('/buy-racy seq')).refused], [1, 4], 'one after another: one sale, then sold out');
    assert.equal(racy[0] && racy[0].kind, 'race', 'at once: more than one sale');
    assert.equal(racy[0].confidence, 'confirmed');
    assert.deepEqual(raceFindings(tally(of('/buy-atomic seq')), tally(of('/buy-atomic conc'))), [], 'the atomic update holds');
    assert.equal(qtyAfter, 1, 'every probe was rolled back');
  });
});
