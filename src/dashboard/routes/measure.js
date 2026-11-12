import { checkTrace, routeOf } from '../../analysis/index.js';
import { REPLAY, SAFE_METHODS } from '../../shared/replay-policy.js';
import { compareTimings, timing } from '../../shared/compare.js';
import { json, readJson } from '../http.js';

/** A run that has served more requests than this is no longer fresh. */
const FRESH_REQUESTS = 50;

const count = (t, kind) => t.spans.filter((x) => x.kind === kind).length;
const describe = (list, last) => ({ ...timing(list.map((t) => t.duration)), status: last.status, queries: count(last, 'db'), redis: count(last, 'redis'), http: count(last, 'http') });

/**
 * Replays a recorded read against the app as it runs now: what an agent uses (through backlens
 * mcp) to check its own change. Each measurement is kept, so the next measurement of the same
 * request compares against it: measure before the change, change the code, measure again.
 *
 * Both sides must be measured the same way to be comparable. A process that has served hundreds of
 * requests was seen to answer twice as fast as a fresh one running the same code, and a code change
 * restarts the app, so every measurement is taken on a fresh app run: the app is restarted first
 * unless this run has not been measured yet and has served few requests. Then warm-up until the
 * request stops getting faster, then the measured runs. Runs that answered with another status
 * (a rate limit's 429, say) are left out and reported. Recorded traffic is returned for context
 * only; it includes cold requests and is never used for a percentage.
 *
 * Either a recorded request (with its headers, so a signed-in page stays signed in), or a path on
 * the app sent as a plain GET with no cookies or headers: public routes only.
 */
export default function measureRoutes({ store, replayer, procs, ai }) {
  return [
    {
      method: 'POST',
      path: '/api/measure',
      async handle(req, res) {
        const body = await readJson(req);
        const id = body && typeof body.id === 'string' ? body.id : '';
        const path = body && typeof body.url === 'string' ? body.url.trim() : '';
        if (path && !/^\/[^\s]*$/.test(path)) return json(res, 400, { error: 'Give a path on the app, like /v1/reviews (no host).' });
        const original = path ? null : store.traces.find((t) => t.id === id);
        if (!path && !original) return json(res, 404, { error: 'No recorded request with that id. List recent requests first.' });
        const payload = path ? { method: 'GET', url: path, headers: {} } : store.replays.get(id);
        if (!payload) return json(res, 400, { error: ai() && ai().replayEnabled() ? 'This request cannot be replayed (its body was too large, or it was recorded before replay was on).' : 'Replay is off in AI settings.' });
        if (!SAFE_METHODS.includes(payload.method)) return json(res, 400, { error: `${payload.method} changes data, so backlens does not replay it here. Measure a read on the same route instead.` });
        const runs = Math.min(REPLAY.maxSamples, Math.max(1, Number(body.runs) || REPLAY.samples));
        const p = procs();
        let port = await p.appPort();
        const run = p.app.startedAt;
        const used = [...store.measured.values()].some((m) => m.run === run) || store.traces.filter((t) => t.at >= run).length > FRESH_REQUESTS;
        let restarted = false;
        if (!port || used) {
          port = await p.restartApp();
          restarted = true;
        }
        if (!port) return json(res, 409, { error: 'The app did not start. Check app_logs.' });
        const all = await replayer.measure(payload, port, { samples: runs });
        if (!all.length) return json(res, 504, { error: `The replayed request did not finish within ${REPLAY.timeoutMs / 1000} s. Check the app logs.` });
        const expected = original ? original.status : all[0].status;
        const samples = all.filter((t) => t.status === expected);
        const odd = all.filter((t) => t.status !== expected);
        const otherStatuses = odd.length ? { runs: odd.length, of: all.length, statuses: [...new Set(odd.map((t) => t.status))] } : null;
        if (!samples.length) return json(res, 409, { error: `Every replay answered ${otherStatuses.statuses.join(', ')} instead of ${expected}${otherStatuses.statuses.includes(429) ? ' (rate limited: wait a minute and try again)' : ''}. Nothing to measure.` });
        const last = samples.at(-1);
        const route = original ? routeOf(original.method, original.url, original.template) : routeOf(last.method, last.url, last.template);
        const since = store.fixedAt.get(`route:${route}`) || 0;
        const status = original ? original.status : last.status;
        const recorded = store.traces.filter((t) => t.at > since && !t.afterFix && routeOf(t.method, t.url, t.template) === route && t.status === status).slice(-runs);
        const key = `${payload.method} ${payload.url}`;
        const previous = store.measured.get(key) || null;
        const now = { ...describe(samples, last), at: Date.now(), run: p.app.startedAt };
        store.measured.set(key, now);
        const seen = new Map();
        for (const t of samples) for (const i of checkTrace(t)) if (!seen.has(i.title)) seen.set(i.title, { type: i.type, title: i.title, sites: i.sites, sql: i.sql });
        return json(res, 200, {
          route,
          recorded: recorded.length ? describe(recorded, recorded.at(-1)) : null,
          previous,
          now,
          change: compareTimings(previous, now),
          restarted,
          otherStatuses,
          issues: [...seen.values()],
          trace: { ...last, route },
        });
      },
    },
  ];
}
