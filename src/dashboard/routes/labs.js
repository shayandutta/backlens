import { json, readJson } from '../http.js';
import { createMemory } from '../memory.js';
import { runRace } from '../race.js';
import { runTrial } from '../trial.js';

/**
 * The 1.0 labs: concurrency probes (POST /api/race), the counterfactual lab (POST /api/trial) and
 * app memory (GET /api/memory, POST /api/memory/note). The two that restart or replay run one at a
 * time, and never alongside the mutation lab's own lock (each has its own).
 */
export default function labRoutes(ctx) {
  const { root, store, replayer, fresh, procs, behavior, getConfig } = ctx;
  const memory = createMemory({ root, store, behavior });
  let busy = null;
  const once = (name, fn) => async (req, res) => {
    if (busy) return json(res, 409, { error: `backlens is already running ${busy}; try again when it finishes.` });
    const body = (await readJson(req).catch(() => null)) || {};
    busy = name;
    try {
      const out = await fn(body);
      return json(res, out.error ? 409 : 200, out);
    } finally {
      busy = null;
    }
  };
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return [
    { method: 'POST', path: '/api/race', handle: once('concurrency probes', (b) => runRace({ root, store, replayer, fresh, id: str(b.id), copies: b.copies })) },
    {
      method: 'POST',
      path: '/api/trial',
      handle: once('the counterfactual lab', (b) => (str(b.id) ? runTrial({ root, store, replayer, procs, behavior, getConfig, id: b.id, fixes: b.fixes, keep: b.keep === true, tests: b.tests !== false }) : { error: 'Give the id of the recorded request the fixes are for.' })),
    },
    {
      method: 'GET',
      path: '/api/memory',
      handle: (req, res, url) => json(res, 200, { text: memory.recall({ route: url.searchParams.get('route') || null, file: url.searchParams.get('file') || null }) }),
    },
    {
      method: 'POST',
      path: '/api/memory/note',
      async handle(req, res) {
        const b = (await readJson(req).catch(() => null)) || {};
        const out = memory.note({ text: b.text, route: str(b.route), file: str(b.file), forget: str(b.forget) });
        return json(res, out.error ? 400 : 200, out);
      },
    },
  ];
}
