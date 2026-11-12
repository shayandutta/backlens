import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../src/analysis/index.js';
import { indexIssues } from '../src/analysis/index-advice.js';
import { confidenceOf } from '../src/analysis/confidence.js';

const f = (fn, line) => [{ fn, file: 'src/orders.ts', line }];
const db = (name, start, params, frames, extra = {}) => ({ kind: 'db', name, start, duration: 2, params, frames, ...extra });
let n = 0;
const tr = (spans, url = '/orders/1') => ({ id: `t${n++}`, method: 'GET', url, status: 200, at: Date.now(), duration: 20, spans });
const issuesOf = (traces) => summarize(traces, [], []).issues;

test('a repeat seen every time, sequential, with code lines, is confirmed', () => {
  const t = () => tr([db('select * from users where id = $1', 0, 'u', f('load', 5)), db('select * from users where id = $1', 4, 'u', f('render', 30))]);
  const [i] = issuesOf([t(), t()]);
  assert.equal(i.type, 'repeat');
  assert.equal(i.confidence.level, 'confirmed');
  assert.deepEqual(i.confidence.against, []);
});

test("the 0.6 false positive: a copy with no code line, overlapping, in a minority of requests, is 'check'", () => {
  const clean = () => tr([db('select * from orders where id = $1', 0, 'o', f('pay', 10))], '/pay/1');
  const doubled = () => tr([db('select * from orders where id = $1', 0, 'o', f('pay', 10)), db('select * from orders where id = $1', 0.5, 'o', [])], '/pay/1');
  const [i] = issuesOf([clean(), doubled(), clean(), clean()]);
  assert.equal(i.confidence.level, 'check');
  const doubts = i.confidence.against.join(' | ');
  assert.match(doubts, /no code location/);
  assert.match(doubts, /ran at the same time/);
  assert.match(doubts, /only seen in 1 of 4 requests/);
});

test('a write to the table between two reads makes a repeat a question, not a verdict', () => {
  const t = tr([
    db('select balance from accounts where id = $1', 0, 'a', f('check', 5)),
    db('update accounts set balance = balance - 10 where id = $1', 3, 'b', f('charge', 9)),
    db('select balance from accounts where id = $1', 6, 'a', f('confirm', 12)),
  ]);
  const i = issuesOf([t]).find((x) => x.type === 'repeat');
  assert.equal(i.confidence.level, 'check');
  assert.match(i.confidence.against.join(), /write to the same table came between/);
});

test('N+1: many values from one line is confirmed; three is likely', () => {
  const many = tr([0, 1, 2, 3, 4, 5].map((k) => db('select * from items where order_id = $1', k * 3, `p${k}`, f('list', 12))));
  assert.equal(issuesOf([many])[0].confidence.level, 'confirmed');
  const few = tr([0, 1, 2].map((k) => db('select * from items where order_id = $1', k * 3, `p${k}`, f('list', 12))));
  assert.equal(issuesOf([few])[0].confidence.level, 'likely');
});

test('serial awaits are never confirmed; without value fingerprints they are check', () => {
  const run = (extra) => tr([db('select * from users where id = $1', 0, 'u', f('page', 4), extra), db('select * from plans where id = $1', 3.2, 'p', f('page', 5), extra)]);
  const checked = issuesOf([run({ took: ['x'], gave: ['y'] })]).find((x) => x.type === 'serial');
  assert.equal(checked.confidence.level, 'likely');
  assert.match(checked.confidence.against.join(), /order may matter/);
  const unchecked = issuesOf([run({})]).find((x) => x.type === 'serial');
  assert.equal(unchecked.confidence.level, 'check');
});

test('index advice: a big selective table is confirmed; a few-valued column is check', () => {
  const trace = { id: 'x', method: 'GET', url: '/admin', status: 200, at: 1, spans: [{ kind: 'db', name: 'select * from lessons where status = $1', start: 0, duration: 1, frames: f('list', 3) }] };
  const advice = (rows, distinct) => ({ sql: 'select * from lessons where status = $1', table: 'lessons', schema: 'public', columns: ['status'], sort: [], rows, distinct });
  assert.equal(confidenceOf({ ...indexIssues([trace], [advice(50000, { status: -0.4 })])[0], seen: 1, of: 1 }).level, 'confirmed');
  assert.equal(confidenceOf({ ...indexIssues([trace], [advice(50000, { status: 3 })])[0], seen: 1, of: 1 }).level, 'check');
});

test("CI: a new finding backlens itself doubts does not fail the build; --strict still counts it", async () => {
  const { judge } = await import('../src/report/judge.js');
  const clean = () => tr([db('select * from orders where id = $1', 0, 'o', f('pay', 10))], '/pay/1');
  const doubled = () => tr([db('select * from orders where id = $1', 0, 'o', f('pay', 10)), db('select * from orders where id = $1', 0.5, 'o', [])], '/pay/1');
  const traces = [clean(), doubled(), clean(), clean()];
  assert.equal(judge(traces, [], new Set()).failing.length, 0);
  assert.equal(judge(traces, [], new Set(), { strict: true }).failing.length, 1);
});

test('serial: a lock first, or a fallback after an empty result, makes it check', () => {
  const run = (a, b) => issuesOf([tr([db(a.name, 0, 'u', f('page', 4), { took: ['x'], gave: [], ...a }), db(b.name, 3.2, 'p', f('page', 5), { took: ['y'], gave: [], ...b })])]).find((x) => x.type === 'serial');
  const lock = run({ name: 'select pg_advisory_xact_lock($1)' }, { name: 'select * from lessons where id = $1' });
  assert.equal(lock.confidence.level, 'check');
  assert.match(lock.confidence.against.join(), /takes a lock/);
  const fallback = run({ name: 'select * from identities where provider_id = $1', rows: 0 }, { name: 'select * from users where email = $1' });
  assert.equal(fallback.confidence.level, 'check');
  assert.match(fallback.confidence.against.join(), /fallback/);
});
