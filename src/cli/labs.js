import { readFileSync } from 'node:fs';
import { api, findSessions, NOT_RUNNING } from '../mcp/session.js';
import { raceText } from '../race/format.js';
import { trialText } from '../trial/format.js';

/**
 * `backlens race`, `backlens try` and `backlens memory`: the labs from a terminal, through the
 * running dashboard. race exits 1 on a race; try exits 1 when no fix won; 2 when they could not run.
 */
export async function runLab({ args, root }) {
  const session = findSessions(root)[0];
  if (!session) {
    process.stderr.write(`${NOT_RUNNING}\n`);
    process.exit(2);
  }
  const rest = args.own.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && ['--id', '--copies'].includes(all[i - 1])));
  const call = (method, path, body) => api(session, method, path, body).catch((err) => ({ error: err.message }));
  if (args.subcommand === 'race') {
    const r = await call('POST', '/api/race', { id: args.flag('--id'), copies: Number(args.flag('--copies')) || undefined });
    process.stdout.write(`${raceText(r)}\n`);
    process.exit(r.error ? 2 : r.races ? 1 : 0);
  }
  if (args.subcommand === 'try') {
    if (!rest[0] || !args.flag('--id')) {
      process.stderr.write('usage: backlens try <fixes.json> --id <request id> [--keep] [--no-tests]\n');
      process.exit(2);
    }
    let fixes;
    try {
      fixes = JSON.parse(readFileSync(rest[0], 'utf8'));
    } catch (err) {
      process.stderr.write(`Could not read ${rest[0]}: ${err.message}\n`);
      process.exit(2);
    }
    const r = await call('POST', '/api/trial', { id: args.flag('--id'), fixes: Array.isArray(fixes) ? fixes : fixes.fixes, keep: args.has('--keep'), tests: !args.has('--no-tests') });
    process.stdout.write(`${trialText(r)}\n`);
    process.exit(r.error ? 2 : r.winner ? 0 : 1);
  }
  // memory [route | file]: a route starts with an HTTP method.
  const what = rest.join(' ');
  const q = new URLSearchParams();
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|JOB)\s/i.test(what)) q.set('route', what.replace(/^\w+/, (m) => m.toUpperCase()));
  else if (what) q.set('file', what);
  const r = await call('GET', `/api/memory?${q}`);
  process.stdout.write(`${r.error || r.text}\n`);
  process.exit(r.error ? 2 : 0);
}
