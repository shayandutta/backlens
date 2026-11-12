import { noContent, readJson } from '../http.js';

/** What the recorder inside the app and test processes reports. */
export default function ingestRoutes({ store, replayer, procs, ai }) {
  return [
    {
      method: 'POST',
      path: '/ingest',
      async handle(req, res) {
        const trace = await readJson(req);
        if (trace && typeof trace.id === 'string' && Array.isArray(trace.spans)) {
          const replay = trace.replay;
          delete trace.replay;
          // A replay (a fix being checked, or measure_request): back to whoever sent it, kept out of the numbers.
          if (trace.replayOf) {
            replayer.onTrace(trace);
            return noContent(res);
          }
          const keep = replay && !replay.truncated && ai() && ai().replayEnabled() ? replay : null;
          if (trace.source === 'test') store.addTestTrace(trace, keep);
          else store.addTrace(trace, keep);
        }
        return noContent(res);
      },
    },
    {
      method: 'POST',
      path: '/adapters',
      async handle(req, res) {
        const a = await readJson(req);
        // The latest process to report wins: after a restart the old one is gone.
        if (a && Array.isArray(a.adapters)) store.adapters = { pid: a.pid, at: Date.now(), list: a.adapters.slice(0, 40) };
        return noContent(res);
      },
    },
    {
      method: 'POST',
      path: '/advice',
      async handle(req, res) {
        const a = await readJson(req);
        if (a && typeof a.sql === 'string' && typeof a.table === 'string' && Array.isArray(a.columns)) store.advice.set(`${a.sql}|${a.table}`, a);
        return noContent(res);
      },
    },
    {
      method: 'POST',
      path: '/routes',
      async handle(req, res) {
        const body = await readJson(req);
        for (const r of (body && body.routes) || []) if (typeof r.method === 'string' && typeof r.path === 'string') store.known.set(`${r.method} ${r.path}`, r);
        return noContent(res);
      },
    },
    {
      method: 'POST',
      path: '/listening',
      async handle(req, res) {
        const body = await readJson(req);
        const { app } = procs();
        if (body && body.source !== 'test' && app && !app.port && Number.isInteger(body.port)) app.port = body.port;
        return noContent(res);
      },
    },
  ];
}
