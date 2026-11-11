import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripAnsi } from '../shared/ansi.js';

/** The project on disk, as a fix touches it: git state, package scripts, and their output. */

/**
 * Files among these with uncommitted changes, or null when the project is not a git repository
 * (then backups are the only undo).
 */
export function gitDirty(root, files) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const out = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...files.map((f) => join(root, f))], { encoding: 'utf8' });
  // Porcelain lines are 'XY path': the status columns can start with a space, so no trim before slicing.
  return out.split('\n').filter((l) => l.trim()).map((l) => l.slice(3));
}

/** Runs a package.json script by name, keeping the last 6000 characters of its output. */
export function runScript(pm, root, script, onOutput) {
  return new Promise((resolve) => {
    const child = spawn(pm, ['run', script], { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let out = '';
    const keep = (d) => {
      out = (out + stripAnsi(String(d))).slice(-6000);
      if (onOutput) onOutput(out);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: 1, out: err.message }));
  });
}

/** The last n lines of some output. */
export const tail = (text, n = 14) => text.trim().split('\n').slice(-n).join('\n');

/** Apps started from built output (node dist/...) need a build before a restart picks up the change. */
export function needsBuild(appCommand, scripts) {
  return appCommand && /\b(node|bun)\s+[^\s]*(dist|build|out)\//.test(appCommand) && scripts.build ? 'build' : null;
}

/** The project's typecheck script, if it has one. */
export const typecheckScript = (scripts) => (scripts.typecheck ? 'typecheck' : scripts['type-check'] ? 'type-check' : null);

export function readSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
