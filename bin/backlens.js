#!/usr/bin/env node
/** The backlens command. Each subcommand lives in src/cli/; see `backlens --help`. */
import { randomBytes } from 'node:crypto';
import { HELP, parseArgs } from '../src/cli/args.js';

const args = parseArgs(process.argv.slice(2));
const ci = args.subcommand === 'test';
if (args.has('-h') || args.has('--help') || (ci && !args.command.length)) {
  process.stderr.write(HELP);
  process.exit(ci && !args.command.length ? 1 : 0);
}

const root = process.cwd();
// The session's secret: the dashboard link, the recorder and `backlens mcp` all carry it.
const token = randomBytes(16).toString('hex');

if (args.subcommand === 'statusline') await import('../src/cli/statusline.js').then((m) => m.runStatuslineCommand({ args }));
else if (args.subcommand === 'mcp') await import('../src/mcp/server.js').then((m) => m.runMcp({ cwd: root, args: args.own.slice(1) }));
else if (args.subcommand === 'diff' || args.subcommand === 'accept') await import('../src/cli/diff.js').then((m) => m.runDiff({ args, root }));
else if (args.subcommand === 'init') await import('../src/harness/init.js').then((m) => m.runInit({ args, root }));
else if (args.subcommand === 'hook' && args.own[1] === 'stop') await import('../src/harness/stop-hook.js').then((m) => m.runStopHookCommand({ harness: ['codex', 'cursor'].includes(args.flag('--harness')) ? args.flag('--harness') : 'claude' }));
else if (args.subcommand === 'hook') {
  process.stderr.write('usage: backlens hook stop\n');
  process.exit(1);
} else if (args.subcommand === 'doctor') await import('../src/cli/doctor.js').then((m) => m.runDoctorCommand({ args, root }));
else if (args.subcommand === 'report') await import('../src/evidence/report.js').then((m) => m.runReport({ args, root }));
else if (ci) await import('../src/cli/ci.js').then((m) => m.runCi({ args, root, token }));
else await import('../src/cli/studio.js').then((m) => m.runStudio({ args, root, token }));
