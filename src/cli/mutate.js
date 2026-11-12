import { mutationText } from '../mutate/format.js';
import { api, findSessions, NOT_RUNNING } from '../mcp/session.js';

/** `backlens mutate [--max N] [--no-tests]`: exit 1 when a guard change went unnoticed. */
export async function runMutateCommand({ args, root }) {
  const session = findSessions(root)[0];
  if (!session) {
    process.stderr.write(`${NOT_RUNNING}\n`);
    process.exit(2);
  }
  let r;
  try {
    r = await api(session, 'POST', '/api/mutate', { max: Number(args.flag('--max')) || undefined, tests: !args.has('--no-tests') });
  } catch (err) {
    r = { error: err.message };
  }
  process.stdout.write(`${mutationText(r)}\n`);
  process.exit(r.error ? 2 : r.gaps ? 1 : 0);
}
