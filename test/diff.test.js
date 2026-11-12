import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { compareFingerprints, compareShapes } from '../src/diff/compare.js';
import { fingerprint } from '../src/diff/fingerprint.js';

const { shapeOf } = createRequire(import.meta.url)('../src/recorder/shape.cjs');

test('a shape has paths and types, never values', () => {
  const s = shapeOf({ items: [{ id: 1, email: 'ada@example.com' }], next: null });
  assert.deepEqual(s, { $: 'object', '$.items': 'array', '$.items[]': 'object', '$.items[].email': 'string', '$.items[].id': 'number', '$.next': 'null' });
  assert.ok(!JSON.stringify(s).includes('ada'));
});

test('a removed field and a changed type are found; data drift is not', () => {
  const before = shapeOf({ user: { id: 1, name: 'a', plan: { tier: 'pro' } }, items: [{ id: 1 }] });
  assert.deepEqual(compareShapes(before, shapeOf({ user: { id: 1, plan: { tier: 'pro' } }, items: [{ id: 1 }] })).removed, ['$.user.name']);
  assert.deepEqual(compareShapes(before, shapeOf({ user: { id: '1', name: 'a', plan: { tier: 'pro' } }, items: [{ id: 1 }] })).retyped, ['$.user.id: number -> string']);
  // An array empty this time, a nested object null this time: data, not a change.
  const drift = compareShapes(before, shapeOf({ user: { id: 1, name: 'a', plan: null }, items: [] }));
  assert.deepEqual(drift, { removed: [], retyped: [], added: [] });
  // A whole removed subtree is reported once, at its top.
  assert.deepEqual(compareShapes(before, shapeOf({ user: { id: 1, name: 'a' }, items: [{ id: 1 }] })).removed, ['$.user.plan']);
  assert.deepEqual(compareShapes(before, shapeOf({ user: { id: 1, name: 'a', plan: { tier: 'pro' }, avatar: 'x' }, items: [{ id: 1 }] })).added, ['$.user.avatar']);
});

const span = (kind, name, extra = {}) => ({ kind, name, start: 0, duration: 1, frames: [{ fn: 'list', file: 'src/a.ts', line: 3 }], ...extra });
const tr = (status, spans, body, duration = 5) => ({ id: 'x', method: 'GET', url: '/a', status, duration, spans, shape: body === undefined ? null : shapeOf(body) });
const fp = (status, spans, body, durations = [5, 5, 5]) => fingerprint(durations.map((d) => tr(status, spans, body, d)));
const base = () => fp(200, [span('db', 'select * from a where id = $1'), span('redis', 'GET k')], { id: 1, name: 'x' });

test('nothing changed: no findings', () => {
  assert.deepEqual(compareFingerprints(base(), base()), []);
});

test('a 500 is broken, and its shape is not compared', () => {
  const f = compareFingerprints(base(), fp(500, [], { error: 'boom' }));
  assert.deepEqual(f.map((x) => x.kind), ['broken']);
  assert.match(f[0].what, /answers 500 \(was 200\)/);
});

test('a lost field is broken; an extra query is a change; one fewer is better', () => {
  const lost = compareFingerprints(base(), fp(200, [span('db', 'select * from a where id = $1'), span('redis', 'GET k')], { id: 1 }));
  assert.deepEqual(lost, [{ kind: 'broken', what: 'response lost $.name' }]);
  const more = compareFingerprints(base(), fp(200, [span('db', 'select * from a where id = $1'), span('db', 'select * from b where a_id = $1'), span('redis', 'GET k')], { id: 1, name: 'x' }));
  assert.equal(more.length, 1);
  assert.equal(more[0].kind, 'changed');
  assert.match(more[0].what, /1 more query \(1 -> 2\), new: select \* from b/);
  const fewer = compareFingerprints(base(), fp(200, [span('redis', 'GET k')], { id: 1, name: 'x' }));
  assert.deepEqual(fewer, [{ kind: 'better', what: '1 fewer query (1 -> 0)' }]);
});

test('a new failing call and a new outgoing host are reported', () => {
  const f = compareFingerprints(base(), fp(200, [span('db', 'select * from a where id = $1', { error: true }), span('redis', 'GET k'), span('http', 'POST https://api.stripe.com/v1/charges')], { id: 1, name: 'x' }));
  assert.deepEqual(f.map((x) => x.kind), ['broken', 'changed']);
  assert.match(f[1].what, /new outgoing call to api\.stripe\.com/);
});

test('time counts only past 100% and 10 ms with every run beyond every baseline run', () => {
  const at = (ds) => fp(200, [span('db', 'select * from a where id = $1'), span('redis', 'GET k')], { id: 1, name: 'x' }, ds);
  assert.deepEqual(compareFingerprints(at([5, 6, 7]), at([6.5, 7.5, 8])), [], 'overlapping runs');
  assert.deepEqual(compareFingerprints(at([7, 7.4, 7.6]), at([13, 13.8, 14])), [], 'noise seen on oldmonk: +87%, +6 ms');
  assert.deepEqual(compareFingerprints(at([1, 1.1, 1.2]), at([4, 4.1, 4.2])), [], 'under 10 ms');
  const slow = compareFingerprints(at([5, 6, 7]), at([60, 61, 62]));
  assert.match(slow[0].what, /slower: 6 -> 61 ms/);
  assert.equal(slow[0].time, true, 'marked, so the diff can re-check or drop it');
});
