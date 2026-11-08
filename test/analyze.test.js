import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTrace, normalizeSql, routeOf, summarize } from '../analyze.js';

const frame = (fn, line, file = 'src/orders.ts') => [{ fn, file, line }];
const db = (name, start, duration, params, fn = 'load', line = 10) => ({ kind: 'db', name, start, duration, params, frames: frame(fn, line) });
const trace = (spans, url = '/orders/42') => ({ id: Math.random().toString(36), method: 'GET', url, status: 200, at: Date.now(), duration: 50, spans });

test('routes group ids, uuids and long tokens', () => {
  assert.equal(routeOf('GET', '/v1/lessons/3f8a0c1e-1111-4222-8333-123456789abc/start'), 'GET /v1/lessons/:id/start');
  assert.equal(routeOf('GET', '/users/42/orders'), 'GET /users/:id/orders');
  assert.equal(routeOf('GET', '/v1/courses/backend-engineering'), 'GET /v1/courses/backend-engineering');
});

test('inlined values are stripped before grouping', () => {
  assert.equal(normalizeSql("select * from t where name = 'ada' and id = 7"), 'select * from t where name = ? and id = ?');
  assert.equal(normalizeSql('select * from t where id in ($1, $2, $3)'), 'select * from t where id in (…)');
});

test('finds the same query with the same values twice', () => {
  const issues = checkTrace(trace([db('select * from progress where user_id = $1', 0, 2, 'aaa', 'lesson', 5), db('select * from progress where user_id = $1', 9, 2, 'aaa', 'courseView', 30)]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'repeat');
  assert.deepEqual(issues[0].sites, ['src/orders.ts:5', 'src/orders.ts:30']);
});

test('repeats from one cause become one issue, named where the paths part', () => {
  const via = (line, inner) => [{ fn: 'userState', file: 'src/access.ts', line: inner }, { fn: 'lesson', file: 'src/catalog.ts', line }];
  const q = (sql, start, line, inner) => ({ kind: 'db', name: sql, start, duration: 1, params: 'u1', frames: via(line, inner) });
  const issues = checkTrace(trace([
    q('select a from progress where user_id = $1', 0, 157, 38), q('select b from owned where user_id = $1', 0.1, 157, 42),
    q('select a from progress where user_id = $1', 9, 178, 38), q('select b from owned where user_id = $1', 9.1, 178, 42),
  ]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, '2 calls are made twice in one request');
  assert.deepEqual(issues[0].sites, ['src/catalog.ts:157', 'src/catalog.ts:178']);
});

test('a cache read then a database load is not flagged as serial', () => {
  const at = (line) => [{ fn: 'get', file: 'src/structure.ts', line }];
  assert.deepEqual(checkTrace(trace([
    { kind: 'redis', name: 'GET catalog', start: 0, duration: 1, params: 'k', hit: false, frames: at(25) },
    { kind: 'db', name: 'select * from courses', start: 1.2, duration: 2, params: 'c', frames: at(31) },
  ])), []);
});

test('finds N+1 and does not also call it serial', () => {
  const spans = [0, 1, 2, 3, 4].map((i) => db('select * from items where order_id = $1', i * 3, 2, `p${i}`, 'list', 12));
  const issues = checkTrace(trace(spans));
  assert.deepEqual(issues.map((i) => i.type), ['n-plus-one']);
  assert.equal(issues[0].cost, 8);
});

test('the same query twice with different values is not an issue', () => {
  assert.deepEqual(checkTrace(trace([db('select * from t where id = $1', 0, 1, 'a', 'x', 1), db('select * from t where id = $1', 5, 1, 'b', 'y', 2)])), []);
});

test('flags calls in one function that wait for each other', () => {
  const issues = checkTrace(trace([db('select * from users where id = $1', 0, 3, 'u', 'page', 4), db('select * from plans where id = $1', 3.2, 3, 'p', 'page', 5)]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'serial');
  assert.equal(issues[0].severity, 'hint');
});

test('calls already running together are not flagged', () => {
  assert.deepEqual(checkTrace(trace([db('select a from x where id = $1', 0, 3, 'u', 'page', 4), db('select b from y where id = $1', 0.2, 3, 'p', 'page', 5)])), []);
});

test('calls from different functions are not flagged as serial', () => {
  assert.deepEqual(checkTrace(trace([db('select a from x where id = $1', 0, 3, 'u', 'auth', 4), db('select b from y where id = $1', 3.5, 3, 'p', 'page', 5)])), []);
});

test('summary counts how often an issue shows up per route', () => {
  const repeated = () => trace([db('select 1 from t where id = $1', 0, 1, 'a', 'f', 1), db('select 1 from t where id = $1', 3, 1, 'a', 'g', 2)]);
  const { routes, issues } = summarize([repeated(), repeated(), trace([], '/orders/9')]);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].calls, 3);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].seen, 2);
  assert.equal(issues[0].of, 3);
});

test('serial calls are reported in the function that awaited them', () => {
  const via = (line) => [{ fn: 'take', file: 'src/limit.ts', line: 37 }, { fn: 'signup', file: 'src/auth.ts', line }];
  const issues = checkTrace(trace([
    { kind: 'redis', name: 'GET user:{id}', start: 0, duration: 2, params: 'a', frames: via(74) },
    { kind: 'redis', name: 'GET plan:{id}', start: 2.1, duration: 2, params: 'b', frames: via(75) },
  ]));
  assert.equal(issues.length, 1);
  assert.match(issues[0].title, /in signup/);
  assert.deepEqual(issues[0].sites, ['src/auth.ts:74', 'src/auth.ts:75']);
});

test('slugs stay, mixed-case tokens become :id', () => {
  assert.equal(routeOf('GET', '/v1/courses/backend-engineering-bible-vol-2'), 'GET /v1/courses/backend-engineering-bible-vol-2');
  assert.equal(routeOf('GET', '/share/V1StGXR8_Z5jdHi6B-myT'), 'GET /share/:id');
});

test('the map reads tables from SQL, skipping keywords that look like tables', async () => {
  const { tablesOf, keyGroup } = await import('../analyze.js');
  assert.deepEqual(tablesOf('insert into "progress" (a) values ($1) on conflict (a) do update set a = excluded.a'), { tables: ['progress'], write: true });
  assert.deepEqual(tablesOf('select x from "lessons" inner join "chapters" on y'), { tables: ['lessons', 'chapters'], write: false });
  assert.equal(keyGroup('rl:route:lesson-read:user:{id}'), 'rl:route:*');
});

test('the map marks real issues on their wires, not hints', async () => {
  const { mapOf } = await import('../analyze.js');
  const t = { id: 'x', method: 'GET', url: '/a/1', status: 200, at: 0, duration: 3, spans: [{ kind: 'db', name: 'select 1 from "orders" where id = $1', start: 0, duration: 1, params: 'p', frames: [] }] };
  const warn = mapOf([t], [{ severity: 'warn', route: 'GET /a/:id', sql: 'select 1 from "orders" where id = $1' }]);
  const hint = mapOf([t], [{ severity: 'hint', route: 'GET /a/:id', sql: 'select 1 from "orders" where id = $1' }]);
  assert.equal(warn.edges[0].issues, 1);
  assert.equal(hint.edges[0].issues, 0);
});

test('calls that use a value an earlier call returned are not flagged as able to run together', () => {
  const at = (line) => [{ fn: 'load', file: 'src/s.ts', line }];
  const dependent = checkTrace(trace([
    { kind: 'db', name: 'select id from modules where course_id = $1', start: 0, duration: 2, params: 'a', took: ['c1'], gave: ['m1', 'm2'], frames: at(10) },
    { kind: 'db', name: 'select id from chapters where module_id in ($1, $2)', start: 2.1, duration: 2, params: 'b', took: ['m1', 'm2'], gave: ['ch1'], frames: at(11) },
  ]));
  assert.deepEqual(dependent, []);
  const independent = checkTrace(trace([
    { kind: 'db', name: 'select a from x where id = $1', start: 0, duration: 2, params: 'a', took: ['u1'], gave: ['q'], frames: at(10) },
    { kind: 'db', name: 'select b from y where id = $1', start: 2.1, duration: 2, params: 'b', took: ['u1'], gave: ['r'], frames: at(11) },
  ]));
  assert.equal(independent.length, 1);
});

test('writes are never suggested to run together, and pin the order around them', () => {
  const at = (line) => [{ fn: 'login', file: 'src/auth.ts', line }];
  assert.deepEqual(checkTrace(trace([
    { kind: 'redis', name: 'EVAL token bucket rl:login:ip:{ip}', start: 0, duration: 2, params: 'a', frames: at(93) },
    { kind: 'redis', name: 'EVAL token bucket rl:login:email:{email}', start: 2.1, duration: 2, params: 'b', frames: at(94) },
  ])), []);
  assert.deepEqual(checkTrace(trace([
    { kind: 'db', name: 'select a from x where id = $1', start: 0, duration: 2, params: 'a', frames: at(10) },
    { kind: 'db', name: 'update y set b = $1', start: 2.1, duration: 2, params: 'b', frames: at(11) },
    { kind: 'db', name: 'select c from z where id = $1', start: 4.2, duration: 2, params: 'c', frames: at(12) },
  ])), []);
});

test('waits are found when one call goes through a helper method', () => {
  const above = [{ fn: 'Controller.mine', file: 'src/c.ts', line: 40 }];
  const issues = checkTrace(trace([
    { kind: 'db', name: 'select code from reviews where user_id = $1', start: 0, duration: 2, params: 'a', frames: [{ fn: 'S.mine', file: 'src/s.ts', line: 68 }, ...above] },
    { kind: 'db', name: 'select 1 from progress where user_id = $1', start: 2.1, duration: 2, params: 'b', frames: [{ fn: 'S.eligible', file: 'src/s.ts', line: 59 }, { fn: 'S.mine', file: 'src/s.ts', line: 72 }, ...above] },
  ]));
  assert.equal(issues.length, 1);
  assert.match(issues[0].title, /in S\.mine/);
  assert.deepEqual(issues[0].sites, ['src/s.ts:68', 'src/s.ts:72']);
});

test('a wrapper line many statements pass through is skipped in locations', () => {
  const wrap = { fn: 'BoundPool.query', file: 'src/common/timing.ts', line: 29 };
  const author = (id, start) => ({ kind: 'db', name: 'select name from users where id = $1', start, duration: 1, params: id, frames: [wrap, { fn: 'S.wall', file: 'src/r.ts', line: 47 }] });
  const issues = checkTrace(trace([
    { kind: 'db', name: 'select id, user_id from reviews', start: 0, duration: 1, params: 'x', frames: [wrap, { fn: 'S.wall', file: 'src/r.ts', line: 32 }] },
    author('a', 2), author('b', 4), author('c', 6),
  ]));
  const n1 = issues.find((i) => i.type === 'n-plus-one');
  assert.deepEqual(n1.sites, ['src/r.ts:47']);
});

test('a kept fix hides its issue until a later request shows it again', () => {
  const repeated = (at) => ({ ...trace([db('select 1 from t where id = $1', 0, 1, 'a', 'f', 1), db('select 1 from t where id = $1', 3, 1, 'a', 'g', 2)]), at });
  const before = repeated(1000);
  const key = summarize([before]).issues[0].key;
  const fixed = new Map([[key, 2000]]);
  const hidden = summarize([before, { ...trace([]), at: 1500 }], [], [], fixed);
  assert.equal(hidden.issues.length, 0);
  assert.equal(hidden.routes[0].issues, 0);
  const back = summarize([before, repeated(3000)], [], [], fixed);
  assert.equal(back.issues.length, 1);
});

test('after a change on a route, issues from its older requests wait for a new request', () => {
  const nPlusOne = (line, at) => ({ ...trace([1, 2, 3].map((i) => db('select name from users where id = $1', i * 2, 1, `p${i}`, 'loop', line))), at });
  const old = nPlusOne(47, 1000);
  const moved = nPlusOne(49, 3000);
  const fixed = new Map([['route:GET /orders/:id', 2000]]);
  const { issues } = summarize([old, moved], [], [], fixed);
  assert.equal(issues.length, 1);
  assert.match(issues[0].sites[0], /:49$/);
});
