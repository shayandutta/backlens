import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asRole } from '../access/login.js';
import { jwtExpired } from '../access/token.js';
import { ambientWrites, dataWrites, routeOf } from '../analysis/index.js';
import { compareFingerprints, RANK } from '../diff/compare.js';
import { fingerprint } from '../diff/fingerprint.js';
import { record } from '../evidence/ledger.js';
import { projectDir } from '../shared/project-config.js';
import { SAFE_METHODS } from '../shared/replay-policy.js';
import { sandboxCheck } from './sandbox-policy.js';

/**
 * The behavior diff: one representative read per route, replayed against the app as it runs now
 * and compared with a baseline taken earlier. Tells an agent what its change did to routes it never
 * looked at, and stays quiet when nothing changed.
 *
 * The baseline on disk (.backlens/behavior.json, mode 600) holds routes, URLs (without a query
 * that looks like it carries a secret) and fingerprints, never headers or values: the requests themselves (cookies, tokens) stay in the dashboard's memory. After a
 * dashboard restart a signed-in route is sent as its login profile's role (the one it was taken
 * as, or the default profile); without a profile it needs one fresh request from the app first. A
 * public route is sent as a plain GET.
 */

export const MAX_ROUTES = 30;
/** Writes (POST, PUT, PATCH, DELETE) in the baseline at most; each is replayed in the rolled-back sandbox. */
export const MAX_WRITES = 10;
const WARMUPS = 1;
const RUNS = 3;
const ACCEPT_FRESH_MS = 10 * 60 * 1000;
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

export function createBehavior({ root, store, replayer, fresh, access = null }) {
  const file = join(projectDir(root), 'behavior.json');
  const payloads = new Map();
  // route -> what the last diff saw, so accepting it right after needs no new replay or restart.
  const lastSeen = new Map();

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

  /**
   * The newest replayable read per route, most-called routes first. A GET that changed data when
   * it was recorded (beyond what every request does, like a rate limiter) is never replayed: such
   * routes are returned in `writing` with what they wrote.
   */
  function candidates() {
    const calls = new Map();
    const newest = new Map();
    const writing = new Map();
    const newWrites = new Map();
    const ambient = ambientWrites(store.traces);
    for (let i = store.traces.length - 1; i >= 0; i--) {
      const t = store.traces[i];
      const route = routeOf(t.method, t.url, t.template);
      calls.set(route, (calls.get(route) || 0) + 1);
      if (newest.has(route) || t.status >= 500) continue;
      const payload = store.replays.get(t.id);
      if (!payload || !payload.url) continue;
      if (!SAFE_METHODS.includes(payload.method)) {
        // A write that worked, made only Postgres changes through pg and called nothing outside:
        // it can be replayed inside a transaction that is rolled back.
        if (t.status < 400 && !newWrites.has(route) && sandboxCheck(t).ok) newWrites.set(route, { route, payload });
        continue;
      }
      const writes = dataWrites(t, ambient);
      if (writes.length) {
        if (!writing.has(route)) writing.set(route, writes);
        continue;
      }
      newest.set(route, { route, payload });
    }
    for (const r of newest.keys()) writing.delete(r);
    const byCalls = (a, b) => calls.get(b.route) - calls.get(a.route) || a.route.localeCompare(b.route);
    const writes = [...newWrites.values()].sort(byCalls).slice(0, MAX_WRITES);
    const list = [...[...newest.values()].sort(byCalls).slice(0, MAX_ROUTES - writes.length), ...writes];
    return Object.assign(list, { writing });
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
    // A write needs its body, which only the recorded request has.
    if (!SAFE_METHODS.includes(entry.method)) return null;
    return entry.authed ? null : { method: entry.method, url: entry.url, headers: {} };
  }

  /**
   * Replays a request: one warm-up, then RUNS runs. { traces } or { skip }, or for a write
   * { breach } when the sandbox did not hold (a query outside the transaction, a failed rollback).
   */
  async function replay(payload, port) {
    const write = !SAFE_METHODS.includes(payload.method);
    const headers = write ? { ...SHAPE_HEADERS, 'x-backlens-sandbox': '1' } : SHAPE_HEADERS;
    const id = randomUUID();
    const sent = [];
    for (let i = 0; i < WARMUPS; i++) sent.push(await replayer.send(payload, port, id, headers));
    const all = [];
    for (let i = 0; i < RUNS; i++) {
      const t = await replayer.send(payload, port, id, headers);
      sent.push(t);
      if (t) all.push(t);
    }
    if (write) {
      const bad = sent.filter(Boolean).find((t) => !t.sandbox || t.sandbox.leaked || !t.sandbox.rolledBack || t.sandbox.error);
      if (bad) return { breach: !bad.sandbox ? 'the recorder in the app does not support the sandbox' : bad.sandbox.leaked ? `${bad.sandbox.leaked} queries ran outside the rolled-back transaction` : bad.sandbox.error || 'a rollback did not complete' };
    }
    if (!all.length) return { skip: 'did not answer in time' };
    const ok = all.filter((t) => t.status !== 429);
    if (!ok.length) return { skip: 'rate limited (429); run the diff again in a minute' };
    const status = ok.at(-1).status;
    return { traces: ok.filter((t) => t.status === status) };
  }

  /** Stops write replays for the rest of a run after a breach, and says so loudly. */
  const breachNote = (route, why) => ({ route, why: `WARNING: the write sandbox did not hold (${why}); writes may have reached the database. No more writes are replayed in this run.` });

  /** Takes the baseline for `routes` (all candidates when null), keeping other entries. */
  async function capture(routes = null) {
    const started = Date.now();
    const old = load();
    const all = candidates();
    const picked = all.filter((c) => !routes || routes.includes(c.route));
    // Accepting a route already in the baseline: its last request, even if traffic moved on.
    if (routes && old) for (const e of old.entries) if (routes.includes(e.route) && !picked.some((c) => c.route === e.route) && payloadFor(e)) picked.push({ route: e.route, payload: payloadFor(e) });
    if (!picked.length) return { entries: old ? old.entries.length : 0, captured: [], skipped: [], ms: 0, error: 'No replayable reads recorded yet. Use the app (open its pages) so backlens has requests to replay.' };
    const { port, restarted, run } = await fresh.freshRun({ maxRequests: 0 });
    if (!port) return { error: 'The app did not start. Check app_logs.' };
    const captured = [];
    const skipped = [...all.writing].filter(([r]) => !routes || routes.includes(r)).map(([route, w]) => ({ route, why: `it changes data when requested (${w.slice(0, 2).join(', ')}), so it is not replayed` }));
    const entries = new Map((old ? old.entries : []).map((e) => [e.route, e]));
    const ambient = new Set([...ambientWrites(store.traces), ...((old && old.ambient) || [])]);
    let writesOff = false;
    for (const c of picked) {
      if (writesOff && !SAFE_METHODS.includes(c.payload.method)) continue;
      const r = await replay(c.payload, port);
      if (r.breach) {
        skipped.push(breachNote(c.route, r.breach));
        writesOff = true;
        continue;
      }
      if (r.skip) {
        skipped.push({ route: c.route, why: r.skip });
        continue;
      }
      const last = r.traces.at(-1);
      const prior = entries.get(c.route);
      if ([401, 403].includes(last.status) && prior && prior.fingerprint.status < 400) {
        skipped.push({ route: c.route, why: `it answers ${last.status} now, which looks like an expired sign-in, not a change; save a login (save_login) or use the page again` });
        continue;
      }
      payloads.set(c.route, c.payload);
      const safe = diskUrl(c.payload.url);
      entries.set(c.route, {
        route: c.route,
        method: c.payload.method,
        path: last.url,
        url: safe.url,
        authed: safe.secret || AUTH_HEADERS.some((h) => c.payload.headers && h in c.payload.headers),
        as: access ? access.sessions.roleOf(c.payload.headers) : null,
        fingerprint: fingerprint(r.traces, ambient),
        at: Date.now(),
      });
      captured.push(c.route);
    }
    fresh.markUsed(run);
    const list = [...entries.values()].slice(0, MAX_ROUTES);
    // Writes every request makes (a rate limiter): kept, so a later diff with no traffic to judge
    // from still knows them.
    save({ version: 1, at: Date.now(), entries: list, ambient: [...ambient] });
    record(root, routes ? 'accept' : 'baseline', { routes: captured, skipped: skipped.length });
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
    const signedIn = new Set();
    let writesOff = false;
    const ambient = new Set([...ambientWrites(store.traces), ...(baseline.ambient || [])]);
    for (const e of entries) {
      let payload = payloadFor(e);
      // The request held in memory may carry a sign-in that has expired by now. A JWT says so
      // itself: then it is not sent at all (an optional-auth route would quietly answer as an
      // anonymous user, and look "better").
      const expired = payload && jwtExpired(payload.headers);
      if (expired && !(access && (e.as || access.profiles.defaultName()))) {
        skipped.push({ route: e.route, why: 'its recorded sign-in has expired; save a login (save_login) so backlens can sign in itself, or use the page again' });
        continue;
      }
      // A route taken as a role is always sent as that role; a signed-in route whose request is
      // gone (or whose sign-in expired) falls back to the default profile.
      const role = access && (e.as || ((!payload || expired) && e.authed ? access.profiles.defaultName() : null));
      if (role) {
        try {
          payload = asRole(payload || { method: e.method, url: e.url, headers: {} }, await access.sessions.headersFor(role, { fresh: restarted && !signedIn.has(role) }));
          signedIn.add(role);
        } catch (err) {
          if (!payload || e.as || expired) {
            skipped.push({ route: e.route, why: err.message });
            continue;
          }
        }
      }
      if (!payload) {
        skipped.push({ route: e.route, why: 'signed-in route and its request is no longer in memory: use the page once in the app, or save a login profile (save_login)' });
        continue;
      }
      if (writesOff && !SAFE_METHODS.includes(payload.method)) {
        skipped.push({ route: e.route, why: 'not replayed after the sandbox did not hold earlier in this run' });
        continue;
      }
      let r = await replay(payload, port);
      if (r.breach) {
        skipped.push(breachNote(e.route, r.breach));
        writesOff = true;
        continue;
      }
      if (r.skip) {
        skipped.push({ route: e.route, why: r.skip });
        continue;
      }
      // The request held in memory may carry a sign-in that has since expired: a route that used
      // to work and now refuses is tried once more as the saved role before it counts.
      const refused = (x) => x.traces && [401, 403].includes(x.traces.at(-1).status) && e.fingerprint.status < 400;
      const fallback = access && !role && (e.as || access.profiles.defaultName());
      if (refused(r) && fallback) {
        try {
          const retry = await replay(asRole(payload, await access.sessions.headersFor(fallback, { fresh: restarted && !signedIn.has(fallback) })), port);
          signedIn.add(fallback);
          if (retry.traces && !refused(retry)) {
            r = retry;
            payload = asRole(payload, await access.sessions.headersFor(fallback));
          }
        } catch {}
      }
      const got = r.traces.at(-1).status;
      if (role && !e.as && (got === 401 || got === 403) && e.fingerprint.status < 400) {
        skipped.push({ route: e.route, why: `sent as ${role} (the default profile), which this route refuses (${got}); use the page once in the app as the right user` });
        continue;
      }
      payloads.set(e.route, payload);
      const now = fingerprint(r.traces, ambient);
      lastSeen.set(e.route, { fingerprint: now, at: Date.now() });
      const findings = compareFingerprints(e.fingerprint, now);
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
        const confirmed = again.traces ? compareFingerprints(c.e.fingerprint, fingerprint(again.traces, ambient)).filter((f) => f.time) : [];
        c.findings = [...c.findings.filter((f) => !f.time), ...confirmed];
        if (again.traces) lastSeen.set(c.e.route, { fingerprint: fingerprint(again.traces, ambient), at: Date.now() });
      }
    }
    for (const c of checked) if (c.findings.length) results.push({ route: c.e.route, findings: c.findings.sort((a, b) => RANK[a.kind] - RANK[b.kind]).map(({ kind, what }) => ({ kind, what })) });
    fresh.markUsed(run);
    results.sort((a, b) => RANK[a.findings[0].kind] - RANK[b.findings[0].kind]);
    const count = (kind) => results.reduce((n, r) => n + r.findings.filter((f) => f.kind === kind).length, 0);
    // Fields that were null in every baseline response: a change in their values cannot be seen.
    const unverifiable = checked.reduce((n, c) => n + Object.values((c.e.fingerprint && c.e.fingerprint.shape) || {}).filter((t) => t === 'null').length, 0);
    record(root, 'diff', { checked: checked.length, broken: count('broken'), changed: count('changed'), better: count('better'), results, skipped: skipped.length, ms: Date.now() - started });
    return {
      checked: checked.length,
      note,
      unverifiable,
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

  /**
   * Takes the routes' behavior now as the new baseline (all routes when none given). Routes the
   * last diff just checked take what it saw (within ACCEPT_FRESH_MS); others are replayed.
   */
  async function accept(routes) {
    const want = routes && routes.length ? routes : null;
    const baseline = load();
    if (want && baseline) {
      const ready = want.every((r) => lastSeen.has(r) && Date.now() - lastSeen.get(r).at < ACCEPT_FRESH_MS && baseline.entries.some((e) => e.route === r));
      if (ready) {
        // A sign-in failure is never taken as the new normal: it is almost always an expired login.
        const authFail = (e) => [401, 403].includes(lastSeen.get(e.route).fingerprint.status) && e.fingerprint.status < 400;
        const skipped = baseline.entries.filter((e) => want.includes(e.route) && authFail(e)).map((e) => ({ route: e.route, why: `it answers ${lastSeen.get(e.route).fingerprint.status} now, which looks like an expired sign-in, not a change; save a login (save_login) or use the page again` }));
        const taken = want.filter((r) => !skipped.some((x) => x.route === r));
        for (const e of baseline.entries) if (taken.includes(e.route)) Object.assign(e, { fingerprint: lastSeen.get(e.route).fingerprint, at: Date.now() });
        if (taken.length) save({ ...baseline, at: Date.now() });
        record(root, 'accept', { routes: taken, skipped: skipped.length });
        return { entries: baseline.entries.length, captured: taken, skipped, ms: 0 };
      }
    }
    return capture(want);
  }

  const list = () => load();

  return { capture, diff, accept, list };
}
