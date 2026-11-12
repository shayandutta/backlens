import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentUsage, withoutBacklens } from '../../agent-usage/index.js';
import { checkTrace, mapOf, routeOf } from '../../analysis/index.js';
import { json } from '../http.js';

/** Recorded traffic: state, the map, one trace, clearing, snapshots, and what agents spent. */
/**
 * Background work linked to a trace: the jobs a request queued (and the traces of their runs), or,
 * for a job run, the request that queued it. Linked by queue name and job id.
 */
function jobLinks(store, trace) {
  const all = [...store.traces, ...store.testRun.traces];
  const queued = [];
  for (const s of trace.spans || []) for (const j of s.job ? [s.job] : s.jobs || []) if (j && j.id) queued.push(j);
  const brief = (t) => ({ id: t.id, route: routeOf(t.method, t.url, t.template), status: t.status, duration: t.duration, queries: t.spans.filter((x) => x.kind === 'db').length, attempt: t.job.attempt });
  const jobs = queued.map((j) => ({ ...j, runs: all.filter((t) => t.job && t.job.queue === j.queue && t.job.id === j.id).map(brief) }));
  let queuedBy = null;
  if (trace.job) {
    const parent = all.find((t) => t !== trace && (t.spans || []).some((s) => [s.job, ...(s.jobs || [])].some((j) => j && j.queue === trace.job.queue && j.id === trace.job.id)));
    if (parent) queuedBy = { id: parent.id, route: routeOf(parent.method, parent.url, parent.template) };
  }
  return { jobs, queuedBy };
}

export default function trafficRoutes({ root, store, snapshotDir }) {
  return [
    {
      method: 'GET',
      path: '/api/state',
      handle(req, res) {
        const { routes, issues } = store.summary();
        const brief = (t) => ({ id: t.id, at: t.at, method: t.method, url: t.url, route: routeOf(t.method, t.url, t.template), status: t.status, duration: t.duration, spans: t.spans.length, aborted: Boolean(t.aborted), afterFix: Boolean(t.afterFix) });
        const recent = store.traces.slice(-300).reverse().map(brief);
        // The last test run's requests too: replayable with measure_request since Phase 3.
        const tests = store.testRun.traces.slice(-300).reverse().map(brief);
        return json(res, 200, { routes, issues, recent, tests, total: store.traces.length, received: store.received });
      },
    },
    {
      method: 'GET',
      path: '/api/map',
      handle(req, res) {
        const { issues } = store.summary();
        return json(res, 200, { ...mapOf(store.traces, issues), advice: store.adviceList().map((a) => ({ table: a.table, columns: a.columns })) });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/trace\/(.*)$/,
      handle(req, res, url, m) {
        const trace = store.findTrace(m[1]);
        if (!trace) return json(res, 404, { error: 'gone' });
        return json(res, 200, { trace: { ...trace, route: routeOf(trace.method, trace.url, trace.template) }, issues: checkTrace(trace), ...jobLinks(store, trace) });
      },
    },
    {
      method: 'POST',
      path: '/api/clear',
      handle(req, res) {
        store.clear();
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/snapshot',
      handle(req, res, url) {
        const name = (url.searchParams.get('name') || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        if (!name) return json(res, 400, { error: 'Give the snapshot a name.' });
        const { routes, issues } = store.summary();
        mkdirSync(snapshotDir, { recursive: true });
        writeFileSync(join(snapshotDir, `${name}.json`), `${JSON.stringify({ name, at: Date.now(), requests: store.traces.length, routes: routes.filter((r) => r.calls), issues: issues.length }, null, 2)}\n`);
        return json(res, 200, { ok: true, name });
      },
    },
    {
      method: 'GET',
      path: '/api/snapshots',
      handle(req, res) {
        const list = existsSync(snapshotDir)
          ? readdirSync(snapshotDir)
              .filter((f) => f.endsWith('.json'))
              .map((f) => {
                try {
                  return JSON.parse(readFileSync(join(snapshotDir, f), 'utf8'));
                } catch {
                  return null;
                }
              })
              .filter(Boolean)
              .sort((a, b) => b.at - a.at)
          : [];
        return json(res, 200, { snapshots: list });
      },
    },
    {
      method: 'GET',
      path: '/api/agent-usage',
      async handle(req, res) {
        const u = await agentUsage({ root });
        return json(res, 200, { ...u, prompts: u.prompts.map((t) => ({ ...t, without: withoutBacklens(t, u.source) })) });
      },
    },
  ];
}
