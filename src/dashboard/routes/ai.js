import { json, readJson } from '../http.js';

const FIX_ACTION = /^\/api\/ai\/fix\/([0-9a-f-]{36})(?:\/(send|apply|keep|revert|escalate|stop))?$/;

/** AI settings, keys, local models, Explain, and the fix jobs. Errors come back as 400 with their message. */
export default function aiRoutes({ ai }) {
  const actions = {
    'GET /api/ai/status': () => ai().status(),
    'POST /api/ai/settings': (body) => ({ settings: ai().saveSettings(body) }),
    'POST /api/ai/key': (body) => ai().setKey(body.key),
    'POST /api/ai/key/remove': () => ai().forgetKey(),
    'POST /api/ai/ollama/pull': (body) => ai().pullModel(body.model),
    'POST /api/ai/ollama/stop': () => ai().stopPullModel(),
    'POST /api/ai/explain': (body) => ai().explain(body.key),
    'POST /api/ai/fix': (body) => ai().startFix(body.key),
  };
  return [
    {
      method: '*',
      path: /^\/api\/ai\//,
      async handle(req, res, url) {
        try {
          const body = req.method === 'POST' ? (await readJson(req)) || {} : {};
          const action = actions[`${req.method} ${url.pathname}`];
          if (action) return json(res, 200, await action(body));
          const m = url.pathname.match(FIX_ACTION);
          if (m && req.method === 'GET' && !m[2]) {
            const job = ai().getFix(m[1]);
            return job ? json(res, 200, job) : json(res, 404, { error: 'gone' });
          }
          if (m && req.method === 'POST' && m[2]) return json(res, 200, await ai()[m[2]](m[1]));
          return json(res, 404, { error: 'not found' });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      },
    },
  ];
}
