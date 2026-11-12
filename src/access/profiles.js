import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir } from '../shared/project-config.js';

/**
 * Login profiles: how to sign in as a role (admin, learner...), so an agent can replay any read as
 * that role by name, without ever seeing a password or token.
 *
 * .backlens/profiles.json (mode 600):
 *   { "default": "admin",
 *     "profiles": { "admin": { "login": { "method": "POST", "url": "/v1/auth/login",
 *       "headers": { "content-type": "application/json" },
 *       "body": "{\"email\":\"${env:SEED_ADMIN_EMAIL}\",\"password\":\"${env:SEED_ADMIN_PASSWORD}\"}" } } } }
 *
 * The file names secrets (${env:NAME}) and never holds them. A login whose secret is not in any
 * .env file is kept in memory for this session only.
 */

const NAME = /^[a-z][\w-]{0,31}$/i;
// Body fields whose values are secrets: a profile that would have to store one is not saved to disk.
const SECRET_FIELD = /pass|secret|token|otp|code|pin|key/i;
// Headers worth keeping on a login request; the rest (cookies, user agents, tracing) are dropped.
const KEEP_HEADERS = ['content-type', 'accept', 'x-requested-with', 'origin'];

export const validName = (n) => typeof n === 'string' && NAME.test(n);

export function createProfiles(root) {
  const file = join(projectDir(root), 'profiles.json');
  const sessionOnly = new Map();

  function read() {
    try {
      const p = JSON.parse(readFileSync(file, 'utf8'));
      return p && typeof p.profiles === 'object' ? p : { default: null, profiles: {} };
    } catch {
      return { default: null, profiles: {} };
    }
  }

  function write(data) {
    mkdirSync(projectDir(root), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  /** Every profile: { name: { login, sessionOnly } }. */
  function all() {
    const out = {};
    for (const [name, p] of Object.entries(read().profiles)) out[name] = { ...p, sessionOnly: false };
    for (const [name, p] of sessionOnly) out[name] = { ...p, sessionOnly: true };
    return out;
  }

  const get = (name) => all()[name] || null;
  const defaultName = () => {
    const d = read().default;
    if (d && get(d)) return d;
    const names = Object.keys(all());
    return names.length === 1 ? names[0] : null;
  };

  /**
   * Saves a login from a recorded request: each body value found in the project's env becomes
   * ${env:NAME}. If a secret-looking field's value is in no env file, the profile is kept for this
   * session only, so the password is never written anywhere. Returns { name, sessionOnly, missing }.
   */
  function saveFromRequest(name, payload, env, makeDefault = false) {
    if (!validName(name)) throw new Error('A profile name is letters, digits, - or _, like admin or learner.');
    const headers = {};
    for (const h of KEEP_HEADERS) if (payload.headers && payload.headers[h]) headers[h] = payload.headers[h];
    let text = payload.body ? Buffer.from(payload.body, 'base64').toString('utf8') : '';
    const missing = [];
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    if (body && typeof body === 'object') {
      const byValue = new Map();
      for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v.length >= 4 && !byValue.has(v)) byValue.set(v, k);
      const templ = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string' && byValue.has(v)) templ[k] = `\${env:${byValue.get(v)}}`;
        else {
          templ[k] = v;
          if (SECRET_FIELD.test(k)) missing.push(k);
        }
      }
      text = JSON.stringify(templ);
    } else if (text) missing.push('(non-JSON body)');
    const login = { method: payload.method, url: payload.url, headers, body: text || null };
    if (missing.length) {
      // The real body (with the secret) stays in memory only.
      sessionOnly.set(name, { login: { ...login, body: payload.body ? Buffer.from(payload.body, 'base64').toString('utf8') : null } });
      return { name, sessionOnly: true, missing };
    }
    const data = read();
    data.profiles[name] = { login };
    if (makeDefault || !data.default) data.default = name;
    write(data);
    sessionOnly.delete(name);
    return { name, sessionOnly: false, missing: [] };
  }

  function setDefault(name) {
    const data = read();
    if (!data.profiles[name]) throw new Error(`No saved profile named ${name}.`);
    data.default = name;
    write(data);
  }

  return { all, get, defaultName, saveFromRequest, setDefault, file };
}
