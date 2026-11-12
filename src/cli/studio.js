import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../dashboard/server.js';
import { bold, dim } from '../shared/ansi.js';
import { ensureIgnore, projectDir } from '../shared/project-config.js';
import { VERSION } from '../shared/version.js';

/** Ports tried without --port: 7777, or the next free one (another backlens may hold 7777). */
const PORTS = Array.from({ length: 20 }, (_, i) => 7777 + i);

/**
 * `backlens`: the dashboard, the app run with the recorder inside, and the session file that lets
 * `backlens mcp` find this dashboard.
 */
export async function runStudio({ args, root, token }) {
  // A stray rejection must not stop the dashboard and, with it, the app it runs.
  process.on('unhandledRejection', (err) => process.stderr.write(`backlens: unexpected error: ${(err && err.stack) || err}\n`));
  const chosen = args.flag('--port');
  const ports = chosen ? [Number(chosen)] : PORTS;
  let server;
  for (const port of ports) {
    try {
      server = await startServer({
        port,
        root,
        token,
        manualArgv: args.command.length ? args.command : null,
        mirror: (line, stream) => process.stderr.write(`${dim('app │')} ${stream === 'sys' ? dim(line) : line}\n`),
      });
      break;
    } catch (err) {
      if (err.code === 'EADDRINUSE' && port !== ports.at(-1)) continue;
      process.stderr.write(`backlens: could not open port ${port} (${err.code ?? err.message}). Try --port.\n`);
      process.exit(1);
    }
  }
  const link = `http://localhost:${server.address().port}/?t=${token}`;
  process.stderr.write(`${bold('backlens')} dashboard ${bold(link)}\n${dim('         keep this link private: it controls your app. Ctrl+C stops everything.')}\n\n`);
  if (!args.has('--no-open')) openBrowser(link);
  server.startApp();
  writeSession(root, { port: server.address().port, token });

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

/**
 * How `backlens mcp` finds this dashboard: the port and token, readable by this user only, in
 * .backlens/ (which backlens keeps out of git). Removed when backlens stops.
 */
function writeSession(root, { port, token }) {
  const sessionFile = join(projectDir(root), 'session.json');
  try {
    mkdirSync(projectDir(root), { recursive: true });
    ensureIgnore(root);
    writeFileSync(sessionFile, `${JSON.stringify({ port, token, pid: process.pid, root, startedAt: Date.now(), version: VERSION })}\n`, { mode: 0o600 });
    chmodSync(sessionFile, 0o600);
  } catch {}
  process.on('exit', () => {
    try {
      rmSync(sessionFile, { force: true });
    } catch {}
  });
}

function openBrowser(link) {
  const [cmd, argv] = process.platform === 'darwin' ? ['open', [link]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : ['xdg-open', [link]];
  try {
    spawn(cmd, argv, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}
