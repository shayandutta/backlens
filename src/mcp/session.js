import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';

/**
 * Finding the running dashboard and talking to it. `npx backlens` leaves its port and token in
 * .backlens/session.json (readable by the user only); the MCP server reads it and calls the
 * dashboard's API with that token.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo']);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readSession(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (Number.isInteger(s.port) && typeof s.token === 'string' && Number.isInteger(s.pid) && alive(s.pid)) return { ...s, file };
  } catch {}
  return null;
}

/** The project's folder and the ones above it, then folders below it (a monorepo's apps/api). */
export function findSessions(cwd) {
  const found = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const s = readSession(join(dir, '.backlens', 'session.json'));
    if (s) found.push(s);
    if (dirname(dir) === dir) break;
  }
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.backlens')) continue;
      const sub = join(dir, e.name);
      if (e.name === '.backlens') {
        const s = readSession(join(sub, 'session.json'));
        if (s && !found.some((f) => f.file === s.file)) found.push(s);
      } else walk(sub, depth + 1);
    }
  };
  walk(resolve(cwd), 1);
  return found.sort((a, b) => b.startedAt - a.startedAt);
}

export const NOT_RUNNING =
  'backlens is not running for this project. Start it in the server folder with `npx backlens` (it records the app while you or your tests use it), then try again.';

export function api(session, method, path, body) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: session.port,
        method,
        path,
        headers: { 'x-backlens-token': session.token, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolvePromise(data);
          else reject(new Error((data && data.error) || `backlens answered ${res.statusCode}`));
        });
      },
    );
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('backlens did not answer in time.')));
    req.on('error', (err) => reject(new Error(err.code === 'ECONNREFUSED' ? NOT_RUNNING : err.message)));
    req.end(payload);
  });
}
