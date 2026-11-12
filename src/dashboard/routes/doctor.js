import { runDoctor } from '../doctor.js';
import { json } from '../http.js';

/** GET /api/doctor: adapters and the measured cost of recording. */
export default function doctorRoutes({ store, procs }) {
  return [
    { method: 'GET', path: '/api/doctor', handle: async (req, res) => json(res, 200, await runDoctor({ store, procs })) },
    // Just the adapters, cheap enough for `status`.
    { method: 'GET', path: '/api/adapters', handle: (req, res) => json(res, 200, store.adapters || { list: [] }) },
  ];
}
