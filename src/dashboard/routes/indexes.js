import { appCommand } from '../app-command.js';
import { json, readJson } from '../http.js';
import { warmUp } from '../replay.js';

/** Creating a suggested index on the database the app is using, through the app itself. */
export default function indexRoutes({ store, procs, token }) {
  return [
    {
      method: 'POST',
      path: /^\/api\/index\/(.*)$/,
      async handle(req, res, url, m) {
        const action = m[1];
        if (!['info', 'create', 'drop'].includes(action)) return json(res, 404, { error: 'not found' });
        const { app } = procs();
        if (!app || !app.port) return json(res, 409, { error: 'The app is not running. Start it first.' });
        const body = (await readJson(req)) || {};
        let index = null;
        const { issues } = store.summary({ withFixed: false });
        const issue = issues.find((i) => i.key === body.key);
        if (action !== 'info') {
          index = issue && issue.index ? issue.index : store.createdIndexes.get(body.key);
          if (!index) return json(res, 404, { error: 'That suggestion is gone. Refresh the list.' });
        }
        try {
          let out;
          try {
            out = await appCommand(app.port, token, { action, ...(index || {}) });
          } catch (err) {
            // A restarted app has no database connection until a request uses one. Replay the
            // request that showed the issue once, unrecorded, so it opens one, then try again.
            const payload = issue && store.replays.get(issue.example);
            if (!/not used Postgres yet/.test(err.message) || !payload || !['GET', 'HEAD'].includes(payload.method)) throw err;
            await warmUp(app.port, payload);
            out = await appCommand(app.port, token, { action, ...(index || {}) });
          }
          if (action === 'create') {
            store.createdIndexes.set(body.key, index);
            store.fixedAt.set(body.key, Date.now());
          }
          if (action === 'drop') {
            store.createdIndexes.delete(body.key);
            store.fixedAt.delete(body.key);
          }
          return json(res, 200, { ...out, index });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      },
    },
  ];
}
