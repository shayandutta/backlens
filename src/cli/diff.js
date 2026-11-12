import { acceptText, diffText } from '../diff/format.js';
import { api, findSessions, NOT_RUNNING } from '../mcp/session.js';

/**
 * `backlens diff` and `backlens accept`: the behavior diff from a terminal or a hook. They talk to
 * the running dashboard for this project, like the MCP server does. diff exits 1 when something
 * broke, 2 when it could not run, 0 otherwise.
 */
export async function runDiff({ args, root }) {
  const session = findSessions(root)[0];
  if (!session) {
    process.stderr.write(`${NOT_RUNNING}\n`);
    process.exit(2);
  }
  const accept = args.subcommand === 'accept';
  const rest = args.own.slice(1).filter((a) => !a.startsWith('--'));
  let out;
  try {
    out = accept
      ? await api(session, 'POST', '/api/behavior/accept', rest.length ? { routes: rest } : {})
      : await api(session, 'POST', '/api/behavior/diff', { route: args.flag('--route'), time: args.has('--time') });
  } catch (err) {
    out = { error: err.message };
  }
  if (!accept && args.has('--json')) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else process.stdout.write(`${accept ? acceptText(out) : diffText(out)}\n`);
  process.exit(out.error ? 2 : !accept && out.broken ? 1 : 0);
}
