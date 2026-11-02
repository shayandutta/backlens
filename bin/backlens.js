#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, judge, readBaseline, writeBaseline } from '../report.js';
import { startServer } from '../server.js';

const HELP = `usage:
  backlens [--port 7777] [--no-open]
      Open the dashboard. Pick how your app starts once; after that, start, restart,
      run tests and review issues from the browser.

  backlens [--port 7777] -- <command>
      Same, but run this exact command as the app.

  backlens test [--baseline file] [--update-baseline] [--strict] [--json file] -- <test command>
      For CI: run your tests, print the report, exit 1 on new issues.
`;

const args = process.argv.slice(2);
const split = args.indexOf('--');
const own = split === -1 ? args : args.slice(0, split);
const command = split === -1 ? [] : args.slice(split + 1);
const testMode = own[0] === 'test';
if (own.includes('-h') || own.includes('--help') || (testMode && !command.length)) {
  process.stderr.write(HELP);
  process.exit(testMode && !command.length ? 1 : 0);
}
const flag = (name) => {
  const i = own.indexOf(name);
  return i === -1 ? undefined : own[i + 1];
};

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const token = randomBytes(16).toString('hex');
const root = process.cwd();

if (testMode) await runTests();
else await runStudio();

async function runStudio() {
  const port = Number(flag('--port') ?? 7777);
  let server;
  try {
    server = await startServer({
      port,
      root,
      token,
      manualArgv: command.length ? command : null,
      mirror: (line, stream) => process.stderr.write(`${dim('app │')} ${stream === 'sys' ? dim(line) : line}\n`),
    });
  } catch (err) {
    process.stderr.write(`backlens: could not open port ${port} (${err.code ?? err.message}). Try --port.\n`);
    process.exit(1);
  }
  const link = `http://localhost:${server.address().port}/?t=${token}`;
  process.stderr.write(`${bold('backlens')} dashboard ${bold(link)}\n${dim('         keep this link private: it controls your app. Ctrl+C stops everything.')}\n\n`);
  if (!own.includes('--no-open')) openBrowser(link);
  server.startApp();

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    process.stderr.write(dim('\nbacklens: stopping\n'));
    await server.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function openBrowser(link) {
  const [cmd, argv] =
    process.platform === 'darwin' ? ['open', [link]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : ['xdg-open', [link]];
  try {
    spawn(cmd, argv, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

async function runTests() {
  const baselineFile = resolve(flag('--baseline') ?? 'backlens.baseline.json');
  let baseline = new Set();
  if (!own.includes('--update-baseline')) {
    try {
      baseline = readBaseline(baselineFile);
    } catch (err) {
      process.stderr.write(`backlens: ${err.message}\n`);
      process.exit(1);
    }
  }
  // Any free port, so CI jobs can run side by side.
  const server = await startServer({ port: 0, root, token });
  const actualPort = server.address().port;
  const register = fileURLToPath(new URL('../register.cjs', import.meta.url));
  process.stderr.write(`${bold('backlens')} recording ${dim(command.join(' '))}\n\n`);
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --enable-source-maps --require ${JSON.stringify(register)}`.trim(),
      BACKLENS_URL: `http://127.0.0.1:${actualPort}`,
      BACKLENS_TOKEN: token,
      BACKLENS_ROOT: root,
    },
  });
  child.on('error', (err) => {
    process.stderr.write(`backlens: could not start ${command[0]}: ${err.message}\n`);
    process.exit(1);
  });
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => {
    const childCode = code ?? (signal ? 1 : 0);
    // Traces are sent as each response finishes; give the last ones a moment to land.
    setTimeout(() => {
      const { traces, known, advice } = server.recorded();
      server.close();
      const result = judge(traces, known, baseline, { strict: own.includes('--strict'), advice });
      process.stderr.write(`${format(result, traces)}\n`);
      const jsonFile = flag('--json');
      if (jsonFile) writeFileSync(resolve(jsonFile), `${JSON.stringify({ routes: result.routes, issues: result.issues, requests: traces.length }, null, 2)}\n`);
      if (own.includes('--update-baseline')) {
        writeBaseline(baselineFile, result.issues);
        process.stderr.write(`\nbacklens: wrote ${result.issues.length} known issue${result.issues.length === 1 ? '' : 's'} to ${baselineFile}\n`);
        process.exit(childCode);
      }
      if (childCode !== 0) process.exit(childCode);
      if (result.failing.length) {
        process.stderr.write(`\nbacklens: ${result.failing.length} new issue${result.failing.length === 1 ? '' : 's'}. Fix ${result.failing.length === 1 ? 'it' : 'them'}, or accept with --update-baseline.\n`);
        process.exit(1);
      }
      process.stderr.write(`\nbacklens: no new issues.\n`);
      process.exit(0);
    }, 500);
  });
}
