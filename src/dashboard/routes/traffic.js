import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentUsage, withoutBacklens } from '../../agent-usage/index.js';
import { checkTrace, mapOf, routeOf } from '../../analysis/index.js';
import { json } from '../http.js';

/** Recorded traffic: state, the map, one trace, clearing, snapshots, and what agents spent. */
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
        return json(res, 200, { trace: { ...trace, route: routeOf(trace.method, trace.url, trace.template) }, issues: checkTrace(trace) });
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
