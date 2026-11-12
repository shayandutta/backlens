import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The project's own secrets, read from its .env files, so a login profile can name them
 * (${env:SEED_ADMIN_PASSWORD}) instead of holding them. Looks in the project folder and up to three
 * folders above it (a monorepo keeps one .env at its root); the nearest file wins, and the real
 * environment wins over all files.
 */

const FILES = ['.env.local', '.env.development.local', '.env.development', '.env'];

/** KEY=VALUE lines; quotes stripped; comments and `export` ignored. Values are never logged. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

export function projectEnv(root) {
  const layers = [];
  let dir = resolve(root);
  for (let i = 0; i < 4; i++) {
    for (const f of FILES) {
      try {
        layers.push(parseEnv(readFileSync(join(dir, f), 'utf8')));
      } catch {}
    }
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  // Nearest first in `layers`; apply farthest first so nearer ones win.
  return Object.assign({}, ...layers.reverse(), process.env);
}

/** Replaces ${env:NAME} with values; throws naming the missing variable (never a value). */
export function fillTemplate(text, env) {
  return String(text).replace(/\$\{env:([A-Za-z_][\w.]*)\}/g, (_, name) => {
    if (env[name] == null) throw new Error(`${name} is not set in the environment or a .env file`);
    return env[name];
  });
}
