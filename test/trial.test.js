import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recoverTrial, runTrial } from '../src/dashboard/trial.js';
import { applyFix, checkFixes, rankFixes } from '../src/trial/rank.js';

test('fixes are checked and applied as exact, unique replacements', () => {
  assert.match(checkFixes([]), /Give 1 to 4/);
  assert.match(checkFixes([{ name: 'a', edits: [{ file: '../x.ts', find: 'a', replace: 'b' }] }]), /not a file of the project/);
  assert.match(checkFixes([{ name: 'a', edits: [{ file: 'x', find: 'a', replace: 'b' }] }, { name: 'a', edits: [{ file: 'x', find: 'a', replace: 'b' }] }]), /Two fixes/);
  const read = () => 'one two two';
  assert.deepEqual(applyFix({ name: 'n', edits: [{ file: 'x.ts', find: 'one', replace: '1' }] }, read).files, { 'x.ts': '1 two two' });
  assert.match(applyFix({ name: 'n', edits: [{ file: 'x.ts', find: 'two', replace: '2' }] }, read).error, /more than once/);
  assert.match(applyFix({ name: 'n', edits: [{ file: 'x.ts', find: 'zzz', replace: '2' }] }, read).error, /not found/);
});

test('ranking: fewer queries wins, then time beyond noise; breaks and failed tests disqualify', () => {
  const base = { status: 200, queries: 21, ms: 40, lo: 38, hi: 44 };
  const r = rankFixes(base, [
    { name: 'cache', status: 200, queries: 1, ms: 5, lo: 4, hi: 6, broken: ['GET /x: lost field'] },
    { name: 'join', status: 200, queries: 2, ms: 9, lo: 8, hi: 10 },
    { name: 'batch', status: 200, queries: 3, ms: 8, lo: 7, hi: 9, tests: true },
    { name: 'oops', status: 500, queries: 1, ms: 2, lo: 2, hi: 2 },
  ]);
  assert.equal(r.winner, 'join');
  assert.match(r.why, /19 fewer queries/);
  assert.equal(rankFixes(base, [{ name: 'same', status: 200, queries: 21, ms: 39, lo: 36, hi: 43 }]).winner, null, 'within noise is not better');
});

test('runTrial measures each fix, puts files back exactly, and keeps the winner only when asked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-trial-'));
  mkdirSync(join(root, 'src'));
  const original = 'for (const id of ids) await db.get(id);\n';
  writeFileSync(join(root, 'src/list.ts'), original);
  // The fake app: as many queries as the file's code implies.
  const queries = () => (readFileSync(join(root, 'src/list.ts'), 'utf8').includes('getMany') ? 1 : 20);
  const span = { kind: 'db', name: 'select 1' };
  const trace = (n) => ({ status: 200, duration: n, spans: Array.from({ length: queries() }, () => span) });
  const seen = [];
  const env = {
    root,
    store: { findTrace: () => ({ method: 'GET', url: '/list', status: 200, spans: [] }), replayOf: () => ({ method: 'GET', url: '/list', headers: {} }) },
    replayer: { measure: async () => (seen.push(readFileSync(join(root, 'src/list.ts'), 'utf8')), [5, 6, 7, 8, 9].map((d) => trace(queries() === 1 ? d : d * 4))) },
    procs: () => ({ restartApp: async () => 1234, pauseWatch: () => {}, runTests: async () => ({ exitCode: 0 }) }),
    behavior: { list: () => null },
    getConfig: () => ({ test: 'test' }),
    id: 'r1',
    fixes: [
      { name: 'batch', edits: [{ file: 'src/list.ts', find: 'for (const id of ids) await db.get(id);', replace: 'await db.getMany(ids);' }] },
      { name: 'noop', edits: [{ file: 'src/list.ts', find: 'await db.get(id)', replace: 'await db.get(id) ' }] },
    ],
  };
  const r = await runTrial(env);
  assert.equal(r.winner, 'batch');
  assert.equal(r.base.queries, 20);
  assert.equal(r.trials[0].queries, 1);
  assert.equal(seen.length, 3, 'as is, then each fix');
  assert.equal(readFileSync(join(root, 'src/list.ts'), 'utf8'), original, 'put back exactly');
  assert.deepEqual(recoverTrial(root), [], 'no marker left');
  const kept = await runTrial({ ...env, keep: true });
  assert.equal(kept.kept, true);
  assert.equal(readFileSync(join(root, 'src/list.ts'), 'utf8'), 'await db.getMany(ids);\n');
});

test('an interrupted run is put back on the next start', () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-trial-'));
  mkdirSync(join(root, '.backlens', 'trial'), { recursive: true });
  writeFileSync(join(root, 'a.ts'), 'mutated');
  writeFileSync(join(root, '.backlens', 'trial', 'backup-0'), 'original');
  writeFileSync(join(root, '.backlens', 'trial', 'active.json'), JSON.stringify({ files: [{ file: 'a.ts', backup: join(root, '.backlens', 'trial', 'backup-0') }] }));
  assert.deepEqual(recoverTrial(root), ['a.ts']);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'original');
});
