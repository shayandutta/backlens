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
else if (ci) await import('../src/cli/ci.js').then((m) => m.runCi({ args, root, token }));
else await import('../src/cli/studio.js').then((m) => m.runStudio({ args, root, token }));
