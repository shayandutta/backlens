import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeOf } from '../analysis/index.js';
import { compareFingerprints, RANK } from '../diff/compare.js';
import { fingerprint } from '../diff/fingerprint.js';
import { projectDir } from '../shared/project-config.js';
import { SAFE_METHODS } from '../shared/replay-policy.js';

/**
 * The behavior diff: one representative read per route, replayed against the app as it runs now
 * and compared with a baseline taken earlier. Tells an agent what its change did to routes it never
 * looked at, and stays quiet when nothing changed.
 *
 * The baseline on disk (.backlens/behavior.json, mode 600) holds routes, URLs (without a query
 * that looks like it carries a secret) and fingerprints, never headers or values: the requests themselves (cookies, tokens) stay in the dashboard's memory. After a
 * dashboard restart a signed-in route needs one fresh request from the app before it can be
 * checked again; a public route is sent as a plain GET.
 */

export const MAX_ROUTES = 30;
const WARMUPS = 1;
const RUNS = 3;
const SHAPE_HEADERS = { 'x-backlens-shape': '1', 'accept-encoding': 'identity' };
const AUTH_HEADERS = ['authorization', 'cookie', 'x-api-key'];
// Query keys that may carry a secret: such a URL is saved without its query, and the route needs a
// request from this dashboard session to be checked (like a signed-in route).
const SECRET_QUERY = /token|code|key|secret|sig|signature|password|auth|session|state/i;

/** The URL safe to write to disk, and whether it lost a secret-looking query. */
function diskUrl(url) {
  const q = url.indexOf('?');
  if (q === -1) return { url, secret: false };
  const keys = [...new URLSearchParams(url.slice(q + 1)).keys()];
  return keys.some((k) => SECRET_QUERY.test(k)) ? { url: url.slice(0, q), secret: true } : { url, secret: false };
}

export function createBehavior({ root, store, replayer, fresh }) {
  const file = join(projectDir(root), 'behavior.json');
  const payloads = new Map();

  function load() {
    try {
      const b = JSON.parse(readFileSync(file, 'utf8'));
      return b && Array.isArray(b.entries) ? b : null;
    } catch {
      return null;
    }
  }

  function save(baseline) {
    mkdirSync(projectDir(root), { recursive: true });
    writeFileSync(file, `${JSON.stringify(baseline, null, 1)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  /** The newest replayable read per route, most-called routes first. */
  function candidates() {
    const calls = new Map();
    const newest = new Map();
    for (let i = store.traces.length - 1; i >= 0; i--) {
      const t = store.traces[i];
      const route = routeOf(t.method, t.url, t.template);
      calls.set(route, (calls.get(route) || 0) + 1);
      if (newest.has(route) || t.status >= 500) continue;
      const payload = store.replays.get(t.id);
      if (!payload || !payload.url || !SAFE_METHODS.includes(payload.method)) continue;
      newest.set(route, { route, payload });
    }
    return [...newest.values()].sort((a, b) => calls.get(b.route) - calls.get(a.route) || a.route.localeCompare(b.route)).slice(0, MAX_ROUTES);
  }

  /** The request to send for a baseline entry, or null if it needs a fresh recording. */
  function payloadFor(entry) {
    if (payloads.has(entry.route)) return payloads.get(entry.route);
    for (let i = store.traces.length - 1; i >= 0; i--) {
      const t = store.traces[i];
      if (t.method !== entry.method || t.url !== entry.path) continue;
      const p = store.replays.get(t.id);
      if (p && (p.url === entry.url || p.url.split('?')[0] === entry.url)) return p;
    }
    return entry.authed ? null : { method: entry.method, url: entry.url, headers: {} };
  }

  /** Replays a request: one warm-up, then RUNS runs. { traces } or { skip }. */
  async function replay(payload, port) {
    const id = randomUUID();
    for (let i = 0; i < WARMUPS; i++) await replayer.send(payload, port, id, SHAPE_HEADERS);
    const all = [];
    for (let i = 0; i < RUNS; i++) {
      const t = await replayer.send(payload, port, id, SHAPE_HEADERS);
      if (t) all.push(t);
    }
    if (!all.length) return { skip: 'did not answer in time' };
    const ok = all.filter((t) => t.status !== 429);
    if (!ok.length) return { skip: 'rate limited (429); run the diff again in a minute' };
    const status = ok.at(-1).status;
    return { traces: ok.filter((t) => t.status === status) };
  }

  /** Takes the baseline for `routes` (all candidates when null), keeping other entries. */
  async function capture(routes = null) {
    const started = Date.now();
    const old = load();
    const picked = candidates().filter((c) => !routes || routes.includes(c.route));
    // Accepting a route already in the baseline: its last request, even if traffic moved on.
    if (routes && old) for (const e of old.entries) if (routes.includes(e.route) && !picked.some((c) => c.route === e.route) && payloadFor(e)) picked.push({ route: e.route, payload: payloadFor(e) });
    if (!picked.length) return { entries: old ? old.entries.length : 0, captured: [], skipped: [], ms: 0, error: 'No replayable reads recorded yet. Use the app (open its pages) so backlens has requests to replay.' };
    const { port, restarted, run } = await fresh.freshRun({ maxRequests: 0 });
    if (!port) return { error: 'The app did not start. Check app_logs.' };
    const captured = [];
    const skipped = [];
    const entries = new Map((old ? old.entries : []).map((e) => [e.route, e]));
    for (const c of picked) {
      const r = await replay(c.payload, port);
      if (r.skip) {
        skipped.push({ route: c.route, why: r.skip });
        continue;
      }
      payloads.set(c.route, c.payload);
      const last = r.traces.at(-1);
      const safe = diskUrl(c.payload.url);
      entries.set(c.route, {
        route: c.route,
        method: c.payload.method,
        path: last.url,
        url: safe.url,
        authed: safe.secret || AUTH_HEADERS.some((h) => c.payload.headers && h in c.payload.headers),
        fingerprint: fingerprint(r.traces),
        at: Date.now(),
      });
      captured.push(c.route);
    }
    fresh.markUsed(run);
    const list = [...entries.values()].slice(0, MAX_ROUTES);
    save({ version: 1, at: Date.now(), entries: list });
    return { entries: list.length, captured, skipped, restarted, ms: Date.now() - started };
  }

  /**
   * Compares every baseline route with the app as it runs now. Time is left out unless asked for:
   * right after a code change a dev watcher is often still compiling, and on oldmonk that made
   * clean routes look 2-4x slower at random. Status, shape, queries, calls and errors are exact.
   */
  async function diff({ route = null, time = false } = {}) {
    const started = Date.now();
    const baseline = load();
    if (!baseline || !baseline.entries.length) return { created: true, ...(await capture()) };
    const entries = baseline.entries.filter((e) => !route || e.route === route);
    if (!entries.length) return { error: `${route} is not in the baseline. Use the page once and accept it to add it.` };
    const { port, restarted, run } = await fresh.freshRun({ maxRequests: 0 });
    if (!port) return { error: 'The app did not start. Check app_logs.' };
    const results = [];
    const skipped = [];
    const checked = [];
    for (const e of entries) {
      const payload = payloadFor(e);
      if (!payload) {
        skipped.push({ route: e.route, why: 'signed-in route and its request is no longer in memory: use the page once in the app' });
        continue;
      }
      const r = await replay(payload, port);
      if (r.skip) {
        skipped.push({ route: e.route, why: r.skip });
        continue;
      }
      payloads.set(e.route, payload);
      const findings = compareFingerprints(e.fingerprint, fingerprint(r.traces));
      checked.push({ e, payload, findings: time ? findings : findings.filter((f) => !f.time) });
    }
    // Time is the one noisy signal. Many routes slower at once is the machine, not the code: drop
    // them all. A few: replay those again, and keep a time finding only if it shows again.
    const timed = checked.filter((c) => c.findings.some((f) => f.time));
    let note = null;
    if (timed.length >= Math.max(3, Math.ceil(checked.length / 3))) {
      for (const c of timed) c.findings = c.findings.filter((f) => !f.time);
      note = `${timed.length} routes ran slower or faster together this time, which points to the machine rather than the code; time was not compared. Run the diff again for timings.`;
    } else {
      for (const c of timed) {
        const again = await replay(c.payload, port);
        const confirmed = again.traces ? compareFingerprints(c.e.fingerprint, fingerprint(again.traces)).filter((f) => f.time) : [];
        c.findings = [...c.findings.filter((f) => !f.time), ...confirmed];
      }
    }
    for (const c of checked) if (c.findings.length) results.push({ route: c.e.route, findings: c.findings.sort((a, b) => RANK[a.kind] - RANK[b.kind]).map(({ kind, what }) => ({ kind, what })) });
    fresh.markUsed(run);
    results.sort((a, b) => RANK[a.findings[0].kind] - RANK[b.findings[0].kind]);
    const count = (kind) => results.reduce((n, r) => n + r.findings.filter((f) => f.kind === kind).length, 0);
    return {
      checked: checked.length,
      note,
      skipped,
      results,
      broken: count('broken'),
      changed: count('changed'),
      better: count('better'),
      baselineAt: baseline.at,
      restarted,
      ms: Date.now() - started,
    };
  }

  /** Takes the routes' behavior now as the new baseline (all routes when none given). */
  const accept = (routes) => capture(routes && routes.length ? routes : null);

  const list = () => load();

  return { capture, diff, accept, list };
}
