import { checkTrace, routeOf } from '../../analysis/index.js';
import { REPLAY, SAFE_METHODS } from '../../shared/replay-policy.js';
import { lowerMedian } from '../../shared/stats.js';
import { json, readJson } from '../http.js';

const count = (t, kind) => t.spans.filter((x) => x.kind === kind).length;
const describe = (list, last) => ({ runs: list.length, ms: lowerMedian(list.map((t) => t.duration)), status: last.status, queries: count(last, 'db'), redis: count(last, 'redis'), http: count(last, 'http') });

/**
 * Replays a recorded read against the app as it runs now and compares it with what was recorded:
 * what an agent uses (through backlens mcp) to check its own change.
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
        const port = await procs().appPort();
        if (!port) return json(res, 409, { error: 'The app is not running. Start it (restart_app) and try again.' });
        const samples = await replayer.measure(payload, port, { samples: runs });
        if (!samples.length) return json(res, 504, { error: `The replayed request did not finish within ${REPLAY.timeoutMs / 1000} s. Check the app logs.` });
        const last = samples.at(-1);
        const route = original ? routeOf(original.method, original.url, original.template) : routeOf(last.method, last.url, last.template);
        const since = store.fixedAt.get(`route:${route}`) || 0;
        const status = original ? original.status : last.status;
        const recorded = store.traces.filter((t) => t.at > since && !t.afterFix && routeOf(t.method, t.url, t.template) === route && t.status === status).slice(-runs);
        const seen = new Map();
        for (const t of samples) for (const i of checkTrace(t)) if (!seen.has(i.title)) seen.set(i.title, { type: i.type, title: i.title, sites: i.sites, sql: i.sql });
        return json(res, 200, {
          route,
          recorded: recorded.length ? describe(recorded, recorded.at(-1)) : null,
          now: describe(samples, last),
          issues: [...seen.values()],
          trace: { ...last, route },
        });
      },
    },
  ];
}
