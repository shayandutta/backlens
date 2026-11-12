/**
 * Compares a request's fingerprint now with its baseline. Pure.
 *
 * Each finding has a kind:
 *   broken  (✗) the route now fails, lost a field, changed a field's type, or hit a new error
 *   changed (~) more queries, a new statement, a new outgoing call, a new perf issue, slower
 *   better  (↑) fewer queries, an issue gone, faster
 *
 * Built to stay quiet on noise: data that drifts (an array empty one time and full the next, a
 * field null one time and set the next) is not a change, and time counts only when it moved by
 * more than SLOWER_PCT and SLOWER_MS and every run is past every baseline run.
 * measure_request is the precise tool for time.
 */

// Coarse on purpose: a diff replays each route only a few times on a just-started app, and on
// oldmonk clean runs moved by up to +87% / +6 ms. Real regressions in queries or calls are caught
// exactly above; time here only catches the gross ones (a sleep, a sync loop, a slow new call).
// measure_request is the precise tool.
export const SLOWER_PCT = 100;
export const SLOWER_MS = 10;

const cls = (status) => Math.floor(status / 100);
const types = (t) => new Set(String(t).split('|'));
const sum = (o) => Object.values(o || {}).reduce((n, v) => n + v, 0);

/** Paths that sit under an array or nullable value that is empty or null in `shape`, so absent for data reasons. */
function hiddenByData(path, shape) {
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '.' && path[i] !== '[') continue;
    const parent = path.slice(0, i);
    const t = shape[parent];
    if (t === undefined) continue;
    const ts = types(t);
    // A parent that is an array with no element paths (empty), or null this time.
    if (ts.has('null')) return true;
    if (ts.has('array') && !Object.keys(shape).some((p) => p.startsWith(`${parent}[]`))) return true;
  }
  return false;
}

/** Removed fields and changed types (broken), new fields (changed). */
export function compareShapes(before, after) {
  const out = { removed: [], retyped: [], added: [] };
  if (!before || !after) return out;
  for (const [path, t] of Object.entries(before)) {
    if (path === '…') continue;
    if (!(path in after)) {
      if (!hiddenByData(path, after) && !after['…']) out.removed.push(path);
      continue;
    }
    const was = types(t);
    const now = types(after[path]);
    was.delete('null');
    now.delete('null');
    // Only real types count: null on either side is data, not a contract change.
    if (was.size && now.size && ![...now].some((x) => was.has(x))) out.retyped.push(`${path}: ${[...was].join('|')} -> ${[...now].join('|')}`);
  }
  for (const path of Object.keys(after)) if (path !== '…' && !(path in before) && !hiddenByData(path, before) && !before['…']) out.added.push(path);
  // Report the top of a removed or added subtree only.
  const tops = (list) => list.filter((p) => !list.some((q) => q !== p && (p.startsWith(`${q}.`) || p.startsWith(`${q}[]`))));
  return { removed: tops(out.removed), retyped: out.retyped, added: tops(out.added) };
}

const list = (xs, n = 3) => `${xs.slice(0, n).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;

/** Findings for one route: [{ kind, what }]. */
export function compareFingerprints(before, after) {
  const f = [];
  const add = (kind, what) => f.push({ kind, what });

  if (before.status !== after.status) {
    const was = cls(before.status);
    const now = cls(after.status);
    if (now === 5 && was !== 5) add('broken', `answers ${after.status} (was ${before.status})`);
    else if (now === 4 && was < 4) add('broken', `answers ${after.status} (was ${before.status})${after.status === 401 || after.status === 403 ? '; if the login expired, sign in again and accept' : ''}`);
    // A refused request that now gets through is an access check gone, not an improvement.
    else if ((before.status === 401 || before.status === 403) && now < 4) add('broken', `answers ${after.status} (was ${before.status}): a request that was refused now gets through`);
    else if (was >= 4 && now < 4) add('better', `answers ${after.status} (was ${before.status})`);
    else add('changed', `answers ${after.status} (was ${before.status})`);
  }
  // A different status means a different response; its shape and calls are not comparable.
  if (cls(before.status) !== cls(after.status)) return f;

  const shape = compareShapes(before.shape, after.shape);
  if (shape.removed.length) add('broken', `response lost ${list(shape.removed)}`);
  if (shape.retyped.length) add('broken', `response field changed type: ${list(shape.retyped, 2)}`);
  if (shape.added.length) add('changed', `response has new ${list(shape.added)}`);

  const newErrors = after.errors.filter((e) => !before.errors.includes(e));
  if (newErrors.length) add('broken', `new failing call: ${list(newErrors, 2)}`);

  // A read that starts changing data is a behavior change worth knowing about, whatever its intent.
  // A baseline from before 0.7 has no writes recorded: nothing to compare against.
  const newWrites = before.writes ? (after.writes || []).filter((w) => !before.writes.includes(w)) : [];
  const isRead = !before.method || ['GET', 'HEAD', 'OPTIONS'].includes(before.method);
  if (newWrites.length) add('changed', isRead ? `now writes when read: ${list(newWrites, 2)}` : `writes something new: ${list(newWrites, 2)}`);

  const q0 = sum(before.queries);
  const q1 = sum(after.queries);
  const newStatements = Object.keys(after.queries).filter((k) => !(k in before.queries));
  if (q1 > q0) add('changed', `${q1 - q0} more ${q1 - q0 === 1 ? 'query' : 'queries'} (${q0} -> ${q1})${newStatements.length ? `, new: ${list(newStatements.map((s) => s.slice(0, 70)), 2)}` : ''}`);
  else if (q1 < q0) add('better', `${q0 - q1} fewer ${q0 - q1 === 1 ? 'query' : 'queries'} (${q0} -> ${q1})`);
  else if (newStatements.length) add('changed', `different queries, same count: new ${list(newStatements.map((s) => s.slice(0, 70)), 2)}`);

  const r0 = sum(before.redis);
  const r1 = sum(after.redis);
  if (r1 > r0) add('changed', `${r1 - r0} more redis ${r1 - r0 === 1 ? 'call' : 'calls'} (${r0} -> ${r1})`);
  else if (r1 < r0) add('better', `${r0 - r1} fewer redis ${r0 - r1 === 1 ? 'call' : 'calls'} (${r0} -> ${r1})`);

  const newHosts = Object.keys(after.http).filter((h) => !(h in before.http));
  if (newHosts.length) add('changed', `new outgoing call to ${list(newHosts)}`);
  const h0 = sum(before.http);
  const h1 = sum(after.http);
  if (!newHosts.length && h1 > h0) add('changed', `${h1 - h0} more outgoing ${h1 - h0 === 1 ? 'call' : 'calls'} (${h0} -> ${h1})`);

  const newIssues = after.issues.filter((i) => !before.issues.includes(i));
  const goneIssues = before.issues.filter((i) => !after.issues.includes(i));
  if (newIssues.length) add('changed', `new issue: ${list(newIssues, 2)}`);
  if (goneIssues.length) add('better', `issue gone: ${list(goneIssues, 2)}`);

  const t0 = before.time;
  const t1 = after.time;
  if (t0 && t1 && t0.ms) {
    const d = t1.ms - t0.ms;
    const pct = Math.round((d / t0.ms) * 100);
    // Every run on one side of every baseline run: with 3 runs a side, the min and max are the ends.
    if (d > SLOWER_MS && pct > SLOWER_PCT && t1.min > t0.max) f.push({ kind: 'changed', what: `slower: ${t0.ms} -> ${t1.ms} ms (+${pct}%)`, time: true });
    else if (-d > SLOWER_MS && -pct > SLOWER_PCT && t1.max < t0.min) f.push({ kind: 'better', what: `faster: ${t0.ms} -> ${t1.ms} ms (${pct}%)`, time: true });
  }
  return f;
}

/** The worst kind in a list of findings, for sorting and exit codes. */
export const RANK = { broken: 0, changed: 1, better: 2 };
export const MARK = { broken: '✗', changed: '~', better: '↑' };
