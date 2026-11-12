import { randomUUID } from 'node:crypto';
import { routeOf } from '../analysis/index.js';
import { record } from '../evidence/ledger.js';
import { raceFindings, tally, usesLocks } from '../race/verdict.js';
import { SAFE_METHODS } from '../shared/replay-policy.js';
import { sandboxCheck } from './sandbox-policy.js';

/**
 * Concurrency probes: fire copies of a recorded write and see whether more get through at once
 * than one after another (see src/race/verdict.js). Every copy runs in the write sandbox: the n
 * copies of a set share one transaction, rolled back when the last answers, so the database ends
 * as it started. Jobs the copies queue are held, never sent to a worker.
 */

export const DEFAULT_COPIES = 5;
const MAX_ROUTES = 3;

/** Recorded writes to probe: the newest that worked per route, through pg, sandboxable. */
function targets(store, id) {
  if (id) {
    const t = store.findTrace(id);
    if (!t) return { error: 'No recorded request with that id. List recent requests first.' };
    const payload = store.replayOf(id);
    if (!payload) return { error: 'This request cannot be replayed (its body was too large, or replay is off).' };
    if (SAFE_METHODS.includes(payload.method)) return { error: `${payload.method} does not change data: probe a POST, PUT, PATCH or DELETE.` };
    const check = sandboxCheck(t);
    if (!check.ok) return { error: `Not probed: ${check.why}.` };
    return { list: [{ route: routeOf(t.method, t.url, t.template), trace: t, payload }] };
  }
  const seen = new Map();
  for (let i = store.traces.length - 1; i >= 0 && seen.size < MAX_ROUTES; i--) {
    const t = store.traces[i];
    const route = routeOf(t.method, t.url, t.template);
    if (seen.has(route) || t.status >= 400 || SAFE_METHODS.includes(t.method)) continue;
    const payload = store.replays.get(t.id);
    const pgWrite = (t.spans || []).some((s) => s.kind === 'db' && s.drv === 'pg' && /^\s*(insert|update|delete|merge)\b/i.test(s.name));
    if (payload && pgWrite && sandboxCheck(t).ok) seen.set(route, { route, trace: t, payload });
  }
  if (!seen.size) return { error: 'No recorded write to probe: use the app once for the action to check (a purchase, a sign-up), or give a request id.' };
  return { list: [...seen.values()] };
}

/** Did a set's shared transaction hold? null when it did, else why not. */
function breachOf(traces, n) {
  if (traces.length < n) return `${n - traces.length} of ${n} copies did not answer in time; the transaction was still rolled back after 30 s`;
  const final = traces.map((t) => t.sandbox).find((s) => s && s.final);
  if (traces.some((t) => !t.sandbox)) return 'the recorder in the app does not support the sandbox (an older backlens?)';
  if (!final) return 'no copy reported the rollback';
  if (final.leaked) return `${final.leaked} queries ran outside the shared transaction`;
  if (!final.rolledBack || final.error) return final.error || 'the rollback did not complete';
  return null;
}

export async function runRace({ root, store, replayer, fresh, id = null, copies = DEFAULT_COPIES }) {
  const n = Math.min(20, Math.max(2, Number(copies) || DEFAULT_COPIES));
  const picked = targets(store, id);
  if (picked.error) return picked;
  const { port, run } = await fresh.freshRun({ maxRequests: Infinity });
  if (!port) return { error: 'The app did not start. Check app_logs.' };
  const results = [];
  for (const { route, payload } of picked.list) {
    const set = async (together) => {
      const header = { 'x-backlens-sandbox': `group:${randomUUID()}:${n}` };
      const send = () => replayer.send(payload, port, randomUUID(), header);
      const got = [];
      if (together) got.push(...(await Promise.all(Array.from({ length: n }, send))));
      else for (let i = 0; i < n; i++) got.push(await send());
      return got.filter(Boolean);
    };
    const seqTraces = await set(false);
    const breachSeq = breachOf(seqTraces, n);
    if (breachSeq) {
      results.push({ route, error: `WARNING: the sandbox did not hold (${breachSeq}); writes may have reached the database. Not probed further.` });
      break;
    }
    const seq = tally(seqTraces);
    if (!seq.ok) {
      results.push({ route, skipped: `no copy succeeded even one after another (status ${[...new Set(seq.statuses)].join(', ')}): nothing to race` });
      continue;
    }
    const concTraces = await set(true);
    const breachConc = breachOf(concTraces, n);
    if (breachConc) {
      results.push({ route, error: `WARNING: the sandbox did not hold (${breachConc}); writes may have reached the database. Not probed further.` });
      break;
    }
    const conc = tally(concTraces);
    const all = [...seqTraces, ...concTraces];
    const locks = usesLocks(all);
    const appRollbacks = all.reduce((x, t) => x + ((t.sandbox && t.sandbox.appRollbacks) || 0), 0);
    const findings = raceFindings(seq, conc, { locks });
    results.push({ route, seq, conc, findings, locks, appRollbacks });
  }
  fresh.markUsed(run);
  const races = results.filter((r) => r.findings && r.findings.some((f) => f.kind === 'race'));
  record(root, 'race', { copies: n, routes: results.map((r) => r.route), races: races.map((r) => ({ route: r.route, what: r.findings.map((f) => f.what) })) });
  return { copies: n, results, races: races.length };
}
