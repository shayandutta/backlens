import { json, readJson } from '../http.js';

/** The behavior diff's API: what `backlens diff`, `backlens accept` and the MCP tools call. */
export default function behaviorRoutes({ behavior }) {
  const one = (fn) => async (req, res) => {
    const out = await fn(await readJson(req).catch(() => null));
    return json(res, out && out.error ? 409 : 200, out);
  };
  return [
    { method: 'GET', path: '/api/behavior', handle: (req, res) => json(res, 200, behavior.list() || { entries: [] }) },
    {
      method: 'GET',
      path: '/api/behavior/last',
      handle: (req, res) => {
        const b = behavior.list();
        json(res, 200, { last: behavior.lastDiff(), baseline: b ? { routes: b.entries.length, at: b.at } : null });
      },
    },
    { method: 'POST', path: '/api/behavior/diff', handle: one((body) => behavior.diff({ route: body && typeof body.route === 'string' ? body.route : null, time: Boolean(body && body.time), changed: Boolean(body && body.changed) })) },
    {
      method: 'POST',
      path: '/api/behavior/accept',
      handle: one((body) => behavior.accept(body && Array.isArray(body.routes) ? body.routes.filter((r) => typeof r === 'string') : null)),
    },
  ];
}
