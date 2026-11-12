import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recorderEnv } from '../dashboard/processes.js';
import { startServer } from '../dashboard/server.js';
import { format, judge, readBaseline, writeBaseline } from '../report/index.js';
import { bold, dim } from '../shared/ansi.js';

/** Traces are sent as each response finishes; give the last ones a moment to land. */
const SETTLE_MS = 500;

/**
 * `backlens test -- <command>`, for CI: runs the tests with recording on, prints every issue, and
 * exits 1 on a new one (not in backlens.baseline.json). Exits with the tests' own code if they fail.
 */
export async function runCi({ args, root, token }) {
  const { command } = args;
  const baselineFile = resolve(args.flag('--baseline') ?? 'backlens.baseline.json');
  const updating = args.has('--update-baseline');
  let baseline = new Set();
  if (!updating) {
    try {
      baseline = readBaseline(baselineFile);
    } catch (err) {
      process.stderr.write(`backlens: ${err.message}\n`);
      process.exit(1);
    }
  }
  // Any free port, so CI jobs can run side by side.
  const server = await startServer({ port: 0, root, token });
  process.stderr.write(`${bold('backlens')} recording ${dim(command.join(' '))}\n\n`);
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: recorderEnv({ port: server.address().port, token, root }),
  });
  child.on('error', (err) => {
    process.stderr.write(`backlens: could not start ${command[0]}: ${err.message}\n`);
    process.exit(1);
  });
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => {
    const childCode = code ?? (signal ? 1 : 0);
    setTimeout(() => {
      const { traces, known, advice } = server.recorded();
      server.close();
      const result = judge(traces, known, baseline, { strict: args.has('--strict'), advice });
      process.stderr.write(`${format(result, traces)}\n`);
      const jsonFile = args.flag('--json');
      if (jsonFile) writeFileSync(resolve(jsonFile), `${JSON.stringify({ routes: result.routes, issues: result.issues, requests: traces.length }, null, 2)}\n`);
      if (updating) {
        writeBaseline(baselineFile, result.issues);
        process.stderr.write(`\nbacklens: wrote ${result.issues.length} known issue${result.issues.length === 1 ? '' : 's'} to ${baselineFile}\n`);
        process.exit(childCode);
      }
      if (childCode !== 0) process.exit(childCode);
      if (result.failing.length) {
        const n = result.failing.length;
        process.stderr.write(`\nbacklens: ${n} new issue${n === 1 ? '' : 's'}. Fix ${n === 1 ? 'it' : 'them'}, or accept with --update-baseline.\n`);
        process.exit(1);
      }
      process.stderr.write(`\nbacklens: no new issues.\n`);
      process.exit(0);
    }, SETTLE_MS);
  });
}
