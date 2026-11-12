import { ambientWrites, checkTrace, dataWrites, ownWrites, routeOf } from '../../analysis/index.js';
import { REPLAY, SAFE_METHODS } from '../../shared/replay-policy.js';
import { compareTimings, timing } from '../../shared/compare.js';
import { asRole } from '../../access/login.js';
import { jwtExpired } from '../../access/token.js';
import { record } from '../../evidence/ledger.js';
import { json, readJson } from '../http.js';
import { sandboxCheck } from '../sandbox-policy.js';

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
export default function measureRoutes({ root, store, replayer, fresh, ai, access }) {
  return [
    {
      method: 'POST',
      path: '/api/measure',
      async handle(req, res) {
        const body = await readJson(req);
        const id = body && typeof body.id === 'string' ? body.id : '';
        const path = body && typeof body.url === 'string' ? body.url.trim() : '';
        if (path && !/^\/[^\s]*$/.test(path)) return json(res, 400, { error: 'Give a path on the app, like /v1/reviews (no host).' });
        const original = path ? null : store.findTrace(id);
        if (!path && !original) return json(res, 404, { error: 'No recorded request with that id. List recent requests first.' });
        const as = body && typeof body.as === 'string' && body.as ? body.as : null;
        let payload = path ? { method: 'GET', url: path, headers: {} } : store.replayOf(id);
        if (!payload) return json(res, 400, { error: ai() && ai().replayEnabled() ? 'This request cannot be replayed (its body was too large, or it was recorded before replay was on).' : 'Replay is off in AI settings.' });
        if (!as && !path && jwtExpired(payload.headers)) {
          const role = access.profiles.defaultName();
          return json(res, 409, { error: `This request's recorded sign-in has expired.${role ? ` Pass as: "${role}" to sign in with the saved login.` : ' Save a login (save_login) or use the page again, then measure the new request.'}` });
        }
        // Writes only in the sandbox: each replay's Postgres work is rolled back.
        const write = !SAFE_METHODS.includes(payload.method);
        let sandbox = null;
        if (write) {
          if (!(body && body.sandbox === true)) return json(res, 400, { error: `${payload.method} changes data. Pass sandbox: true to replay it inside a rolled-back transaction, or measure a read on the same route instead.` });
          if (!original) return json(res, 400, { error: 'Only a recorded write can be sandboxed (backlens checks what it did first).' });
          const check = sandboxCheck(original);
          if (!check.ok) return json(res, 400, { error: `Not replayed: ${check.why}.` });
          sandbox = { redisWrites: check.redisWrites };
        }
        const runs = Math.min(REPLAY.maxSamples, Math.max(1, Number(body.runs) || REPLAY.samples));
        const { port, restarted, run } = await fresh.freshRun();
        if (!port) return json(res, 409, { error: 'The app did not start. Check app_logs.' });
        // As a role: sign in after any restart (an app may keep sessions in memory), then swap
        // the request's own auth headers for the role's. The token never leaves backlens.
        if (as) {
          try {
            payload = asRole(payload, await access.sessions.headersFor(as, { fresh: restarted }));
          } catch (err) {
            return json(res, 409, { error: err.message });
          }
        }
        // Sandboxed writes warm up less: each run is rolled back, but Redis writes (rate limits, counters) add up.
        const all = await replayer.measure(payload, port, sandbox ? { samples: Math.min(runs, 5), maxWarmups: 6, headers: { 'x-backlens-sandbox': '1' } } : { samples: runs });
        if (sandbox) {
          const results = all.map((t) => t.sandbox).filter(Boolean);
          const leaked = results.reduce((n, r) => n + (r.leaked || 0), 0);
          const failed = results.filter((r) => !r.rolledBack || r.error);
          sandbox.contained = results.length === all.length && !leaked && !failed.length;
          sandbox.leaked = leaked;
          sandbox.statements = results.reduce((n, r) => n + (r.statements || 0), 0);
          if (failed.length) sandbox.error = failed[0].error || 'a rollback did not complete';
          if (results.length < all.length) sandbox.error = 'the recorder in the app does not know the sandbox (an older backlens?)';
        }
        if (!all.length) return json(res, 504, { error: `The replayed request did not finish within ${REPLAY.timeoutMs / 1000} s. Check the app logs.` });
        const expected = original ? original.status : all[0].status;
        const samples = all.filter((t) => t.status === expected);
        const odd = all.filter((t) => t.status !== expected);
        const otherStatuses = odd.length ? { runs: odd.length, of: all.length, statuses: [...new Set(odd.map((t) => t.status))] } : null;
        if (!samples.length) {
          const authHint = !as && otherStatuses.statuses.some((x) => x === 401 || x === 403) && access.profiles.defaultName() ? ` The recorded sign-in has probably expired: pass as: "${access.profiles.defaultName()}".` : '';
          return json(res, 409, { error: `Every replay answered ${otherStatuses.statuses.join(', ')} instead of ${expected}${otherStatuses.statuses.includes(429) ? ' (rate limited: wait a minute and try again)' : ''}. Nothing to measure.${authHint}` });
        }
        const last = samples.at(-1);
        const route = original ? routeOf(original.method, original.url, original.template) : routeOf(last.method, last.url, last.template);
        const since = store.fixedAt.get(`route:${route}`) || 0;
        const status = original ? original.status : last.status;
        const recorded = store.traces.filter((t) => t.at > since && !t.afterFix && routeOf(t.method, t.url, t.template) === route && t.status === status).slice(-runs);
        const key = `${payload.method} ${payload.url}${as ? ` as ${as}` : ''}`;
        const previous = store.measured.get(key) || null;
        fresh.markUsed(run);
        const now = { ...describe(samples, last), at: Date.now(), run };
        store.measured.set(key, now);
        const seen = new Map();
        for (const t of samples) for (const i of checkTrace(t)) if (!seen.has(i.title)) seen.set(i.title, { type: i.type, title: i.title, sites: i.sites, sql: i.sql });
        // The code changed and an issue the dashboard lists for this route is gone from the replay
        // (same kind, same statements; its lines may have moved): count it as fixed, as Keep does.
        // The replay joins the recorded requests as the after-fix one, so anything still there
        // shows again from it, and a later request with the issue brings it back.
        const listed = store.summary().issues.filter((i) => i.route === route && i.type !== 'index');
        const gone = listed.filter((i) => ![...seen.values()].some((x) => x.type === i.type && x.sql === i.sql));
        if (gone.length) store.markFixed(gone[0].key, last);
        // A read that changed data while it was replayed: every run changed it again.
        const ambient = ambientWrites(store.traces);
        const writes = sandbox ? [] : dataWrites(last, ambient);
        const redisWrites = sandbox ? [] : ownWrites(last, ambient).filter((w) => w.startsWith('redis '));
        const brief = (x) => x && { ms: x.ms, lo: x.lo, hi: x.hi, runs: x.runs, status: x.status, queries: x.queries, redis: x.redis, http: x.http };
        record(root, 'measure', { route, as, previous: brief(previous), now: brief(now), change: compareTimings(previous, now), issues: seen.size });
        return json(res, 200, {
          route,
          as,
          sandbox,
          writes,
          redisWrites,
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
