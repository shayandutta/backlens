import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, stableKey } from '../src/report/index.js';

const via = (line) => [{ fn: 'f', file: 'src/a.ts', line }, { fn: 'g', file: 'src/b.ts', line: line + 1 }];
const repeated = (lineA, lineB) => ({
  id: String(Math.random()), method: 'GET', url: '/a/1', status: 200, at: 0, duration: 5,
  spans: [
    { kind: 'db', name: 'select 1 from t where id = $1', start: 0, duration: 1, params: 'x', frames: via(lineA) },
    { kind: 'db', name: 'select 1 from t where id = $1', start: 3, duration: 1, params: 'x', frames: via(lineB) },
  ],
});

test('an issue keeps its identity when lines move', () => {
  const a = judge([repeated(10, 20)], [], new Set()).issues[0];
  const b = judge([repeated(14, 27)], [], new Set()).issues[0];
  assert.equal(stableKey(a), stableKey(b));
});

test('only new warnings fail; known ones and hints do not', () => {
  const first = judge([repeated(10, 20)], [], new Set());
  assert.equal(first.failing.length, 1);
  const baseline = new Set(first.issues.map(stableKey));
  assert.equal(judge([repeated(12, 22)], [], baseline).failing.length, 0);
});

test('hints fail only in strict mode', () => {
  const serial = { id: 's', method: 'POST', url: '/x', status: 200, at: 0, duration: 9, spans: [
    { kind: 'db', name: 'select a from x where id = $1', start: 0, duration: 2, params: 'p', frames: [{ fn: 'page', file: 'src/p.ts', line: 4 }] },
    { kind: 'db', name: 'select b from y where id = $1', start: 2.1, duration: 2, params: 'q', frames: [{ fn: 'page', file: 'src/p.ts', line: 5 }] },
  ] };
  assert.equal(judge([serial], [], new Set()).failing.length, 0);
  assert.equal(judge([serial], [], new Set(), { strict: true }).failing.length, 1);
});
