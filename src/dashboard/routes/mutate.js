import { json, readJson } from '../http.js';
import { runMutations } from '../mutate.js';

/** POST /api/mutate { max, tests }: the mutation lab. One run at a time. */
export default function mutateRoutes({ root, store, procs, behavior, getConfig }) {
  let running = false;
  return [
    {
      method: 'POST',
      path: '/api/mutate',
      async handle(req, res) {
        if (running) return json(res, 409, { error: 'A mutation run is already going.' });
        const body = (await readJson(req)) || {};
        running = true;
        try {
          const max = Math.min(30, Math.max(1, Number(body.max) || 8));
          const out = await runMutations({ root, store, procs, behavior, getConfig, max, tests: body.tests !== false });
          return json(res, out.error ? 409 : 200, out);
        } finally {
          running = false;
        }
      },
    },
  ];
}
