import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { sandboxCheck } from '../src/dashboard/sandbox-policy.js';
import { reportMarkdown } from '../src/evidence/report.js';

const sandbox = createRequire(import.meta.url)('../src/recorder/sandbox.cjs');

test('the PR report says what was caught, accepted and measured', () => {
  const t = (ms, lo, hi, queries = 3) => ({ ms, lo, hi, runs: 5, status: 200, queries });
  const md = reportMarkdown([
    { at: 1, kind: 'measure', route: 'GET /v1/admin/users/:id', now: t(8.4, 7.9, 9.1) },
    { at: 2, kind: 'diff', checked: 17, broken: 1, changed: 0, better: 0, results: [{ route: 'GET /v1/me/orders', findings: [{ kind: 'broken', what: 'answers 500 (was 200)' }] }] },
    { at: 3, kind: 'hook', blocked: true },
    { at: 4, kind: 'diff', checked: 17, broken: 0, changed: 1, better: 0, results: [{ route: 'GET /v1/auth/me', findings: [{ kind: 'changed', what: 'response has new $.plan' }] }] },
    { at: 5, kind: 'accept', routes: ['GET /v1/auth/me'] },
    { at: 6, kind: 'measure', route: 'GET /v1/admin/users/:id', now: t(5.6, 5.3, 5.9) },
  ]);
  assert.match(md, /Last check: 17 routes replayed, no breaks/);
  assert.match(md, /Breaks caught during the work: `GET \/v1\/me\/orders` \(the agent was sent back 1 time\); all fixed or accepted/);
  assert.match(md, /`GET \/v1\/auth\/me`: response has new \$\.plan/);
  assert.match(md, /\| `GET \/v1\/admin\/users\/:id` \| 8\.4 ms \(7\.9–9\.1\) \| 5\.6 ms \(5\.3–5\.9\) \| faster \(-33%\) \| 3 → 3 \|/);
  assert.match(reportMarkdown([]), /Nothing recorded/);
});

test('sandbox: the app\'s own transaction statements become savepoints', () => {
  const sb = sandbox.create();
  assert.deepEqual(sandbox.rewriteArgs(sb, ['BEGIN']), ['SAVEPOINT backlens_1']);
  assert.deepEqual(sandbox.rewriteArgs(sb, [{ text: 'start transaction isolation level serializable' }]), [{ text: 'SAVEPOINT backlens_2' }]);
  assert.deepEqual(sandbox.rewriteArgs(sb, ['ROLLBACK']), ['ROLLBACK TO SAVEPOINT backlens_2']);
  assert.deepEqual(sandbox.rewriteArgs(sb, ['COMMIT']), ['RELEASE SAVEPOINT backlens_1']);
  assert.deepEqual(sandbox.rewriteArgs(sb, ['COMMIT']), ['SELECT 1'], 'a stray COMMIT can never end the outer transaction');
  assert.deepEqual(sandbox.rewriteArgs(sb, ['insert into t values ($1)', [1]]), ['insert into t values ($1)', [1]]);
  assert.deepEqual(sandbox.rewriteArgs(sb, ['rollback to savepoint x']), ['rollback to savepoint x'], "the app's own savepoints are left alone");
});

test('sandbox: writes that call out, or skip pg, are refused; Redis writes are listed', () => {
  const span = (kind, name, extra = {}) => ({ kind, name, ...extra });
  assert.equal(sandboxCheck({ spans: [span('db', 'insert into orders', { drv: 'pg' }), span('http', 'POST https://api.stripe.com/v1/charges')] }).ok, false);
  assert.match(sandboxCheck({ spans: [span('db', 'insert into orders')] }).why, /do not go through pg/);
  assert.deepEqual(sandboxCheck({ spans: [span('db', 'insert into orders', { drv: 'pg' }), span('redis', 'INCR rl:ip'), span('redis', 'GET k')] }), { ok: true, redisWrites: ['INCR'] });
});

test('sandbox: a closed sandbox refuses late queries', async () => {
  const sb = sandbox.create();
  const result = await sandbox.close(sb);
  assert.deepEqual(result, { statements: 0, leaked: 0, rolledBack: true, error: null });
  await assert.rejects(sandbox.pinned(sb, {}, async () => ({}), async () => {}), /already finished/);
});
