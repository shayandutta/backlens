import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../src/analysis/index.js';
import { indexIssues } from '../src/analysis/index-advice.js';
import { compareTimings, timing } from '../src/shared/compare.js';

test('a timing is the median with its middle half', () => {
  assert.deepEqual(timing([9, 5, 6, 5.5, 30]), { ms: 6, lo: 5.5, hi: 9, runs: 5 });
  assert.equal(timing([]), null);
});

test('overlapping runs are within noise, with no percentage', () => {
  // The real oldmonk insights change: 5.42 -> 5.14 ms with runs that overlap.
  const c = compareTimings(timing([5.1, 5.3, 5.42, 5.6, 6.2]), timing([4.9, 5.0, 5.14, 5.5, 5.9]));
  assert.equal(c.verdict, 'same');
  assert.equal(c.pct, null);
});

test('runs that separate by at least 1 ms are a real change', () => {
  const c = compareTimings(timing([7.1, 7.2, 7.34, 7.5, 9]), timing([5.4, 5.5, 5.64, 5.7, 6]));
  assert.equal(c.verdict, 'faster');
  assert.equal(c.pct, -23);
  assert.equal(compareTimings(timing([1, 1.1, 1.2]), timing([1.5, 1.6, 1.7])).verdict, 'same', 'under 1 ms is never a verdict');
  assert.equal(compareTimings(null, timing([1])), null);
});

test('serial cost is the median per request, so cold first requests do not inflate it', () => {
  const pair = (a, b) => ({
    id: Math.random().toString(36), method: 'GET', url: '/page', status: 200, at: Date.now(), duration: a + b,
    spans: [
      { kind: 'db', name: 'select * from users where id = $1', start: 0, duration: a, params: 'u', frames: [{ fn: 'page', file: 'src/p.ts', line: 4 }] },
      { kind: 'db', name: 'select * from plans where id = $1', start: a + 0.1, duration: b, params: 'p', frames: [{ fn: 'page', file: 'src/p.ts', line: 5 }] },
    ],
  });
  const { issues } = summarize([pair(40, 30), pair(2, 1), pair(2, 1)], [], []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'serial');
  assert.equal(issues[0].cost, 1, 'median of 30, 1, 1; the mean would say 10.7');
});

const trace = { id: 't1', method: 'GET', url: '/admin', status: 200, at: 1, duration: 5, spans: [{ kind: 'db', name: 'select * from lessons where status = $1', start: 0, duration: 1, frames: [{ fn: 'list', file: 'src/a.ts', line: 3 }] }] };
const advice = (rows, distinct) => ({ sql: 'select * from lessons where status = $1', table: 'lessons', schema: 'public', columns: ['status'], sort: [], rows, distinct });

test('no index issue on a small table', () => {
  assert.deepEqual(indexIssues([trace], [advice(35)]), []);
  assert.deepEqual(indexIssues([trace], [advice(0)]), []);
});

test('a big table filtered on a selective column is a warning', () => {
  const [i] = indexIssues([trace], [advice(50000, { status: -0.4 })]);
  assert.equal(i.severity, 'warn');
  assert.match(i.fix, /CREATE INDEX CONCURRENTLY lessons_status_idx ON lessons \(status\);/);
});

test('a big table filtered on a column with few values is a hint that says so', () => {
  const [i] = indexIssues([trace], [advice(50000, { status: 3 })]);
  assert.equal(i.severity, 'hint');
  assert.match(i.fix, /only a few different values/);
  assert.match(i.fix, /WHERE <that value>/);
});
