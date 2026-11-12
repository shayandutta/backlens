import { api, findSessions, NOT_RUNNING } from '../mcp/session.js';
import { doctorText } from '../report/doctor.js';

/** `backlens doctor`: asks the running dashboard. Exit 1 when an adapter needs a look. */
export async function runDoctorCommand({ args, root }) {
  const session = findSessions(root)[0];
  if (!session) {
    process.stderr.write(`${NOT_RUNNING}\n`);
    process.exit(2);
  }
  let d;
  try {
    d = await api(session, 'GET', '/api/doctor');
  } catch (err) {
    d = { error: err.message };
  }
  process.stdout.write(`${args.has('--json') ? JSON.stringify(d, null, 2) : doctorText(d)}\n`);
  process.exit(d.error ? 2 : d.adapters && d.adapters.some((a) => a.status !== 'ok') ? 1 : 0);
}
