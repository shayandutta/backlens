import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMemory } from '../src/dashboard/memory.js';
import { historyOf, recallText } from '../src/memory/recall.js';

const ledger = [
  { at: 1, kind: 'diff', results: [{ route: 'POST /orders', findings: [{ kind: 'broken', what: 'status 201 -> 500' }] }] },
  { at: 2, kind: 'mutation', gaps: ['src/orders.ts:12 remove-guard'] },
  { at: 3, kind: 'race', races: [{ route: 'POST /orders', what: ['3 of 3 copies succeeded at once'] }] },
  { at: 4, kind: 'measure', route: 'GET /orders', previous: { queries: 21, ms: 40 }, now: { queries: 2, ms: 9 }, change: { verdict: 'faster' } },
];

test('history is read from the ledger: breaks, gaps, races, measurements', () => {
  const h = historyOf(ledger);
  assert.deepEqual(h.map((x) => x.kind), ['broke', 'gap', 'race', 'measured']);
  assert.equal(h[1].file, 'src/orders.ts');
});

test('recall by route, by file and overall', () => {
  const uses = new Map([
    ['POST /orders', { files: ['src/orders.ts'], tables: ['orders', 'stock'] }],
    ['GET /orders', { files: ['src/list.ts'], tables: ['orders'] }],
  ]);
  const routes = [{ route: 'POST /orders', calls: 3, p50: 12, queries: 4, redis: 0, http: 0, errors: 0 }];
  const notes = [{ id: 'n1', text: 'orders must stay idempotent', route: 'POST /orders' }];
  const r = recallText({ route: 'POST /orders', routes, uses, ledger, notes, issues: [{ route: 'POST /orders', title: 'N+1', confidence: { level: 'confirmed' } }] });
  assert.match(r, /code it runs: src\/orders\.ts/);
  assert.match(r, /shares data with: GET \/orders/);
  assert.match(r, /N\+1 \[confirmed\]/);
  assert.match(r, /broke: status 201 -> 500/);
  assert.match(r, /gap: remove-guard at src\/orders\.ts:12/, "a gap in the route's file is its history too");
  assert.match(r, /\[n1\] orders must stay idempotent/);
  const f = recallText({ file: 'src/orders.ts', uses, ledger, notes });
  assert.match(f, /routes that run it: POST \/orders/);
  assert.match(recallText({ file: 'src/none.ts', uses }), /checks all of them/);
  assert.match(recallText({ routes, uses, ledger, notes }), /Past failures and gaps/);
});

test('notes are kept on disk and can be forgotten', () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-mem-'));
  const m = createMemory({ root, store: { traces: [], summary: () => ({ routes: [], issues: [] }) }, behavior: { list: () => null } });
  assert.equal(m.note({ text: 'x', route: 'GET /a' }).id, 'n1');
  assert.equal(m.note({ text: 'y' }).id, 'n2');
  assert.ok(m.note({ text: '  ' }).error);
  assert.equal(m.note({ forget: 'n1' }).notes, 1);
  assert.match(m.recall(), /\[n2\] y/);
});
