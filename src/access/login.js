import http from 'node:http';
import { fillTemplate } from './env.js';

/**
 * Signing in as a profile: sends its login request to the app (unrecorded) and keeps what the app
 * handed back (a bearer token from the JSON body, cookies from Set-Cookie) in memory, as headers to
 * add to replays. Nothing here is returned to an agent or the browser; only the role's name is.
 */

const TOKEN_KEYS = ['accessToken', 'access_token', 'token', 'jwt', 'idToken', 'id_token', 'authToken'];
const TTL_MS = 10 * 60 * 1000;

function findToken(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 2) return null;
  for (const k of TOKEN_KEYS) if (typeof body[k] === 'string' && body[k].length >= 8) return body[k];
  for (const v of Object.values(body)) {
    const t = findToken(v, depth + 1);
    if (t) return t;
  }
  return null;
}

function send(port, { method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { ...headers, ...(data ? { 'content-length': data.length } : {}), 'x-backlens': 'skip' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('the login request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

export function createSessions({ profiles, env, appPort }) {
  // name -> { headers, at }
  const held = new Map();

  /** Signs in (or reuses a recent sign-in): the auth headers for this role. Throws a plain reason. */
  async function headersFor(name, { fresh = false } = {}) {
    const p = profiles.get(name);
    if (!p) throw new Error(`No login profile named ${name}. Save one with save_login (from a recorded sign-in request).`);
    const h = held.get(name);
    if (h && !fresh && Date.now() - h.at < TTL_MS) return h.headers;
    const port = await appPort();
    if (!port) throw new Error('The app is not running.');
    const login = { ...p.login, url: p.login.url, body: p.login.body == null ? null : fillTemplate(p.login.body, env()) };
    const res = await send(port, login);
    if (res.status >= 400) throw new Error(`Signing in as ${name} failed: the app answered ${res.status} to ${p.login.method} ${p.login.url.split('?')[0]}.`);
    const headers = {};
    const cookies = [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter(Boolean);
    if (cookies.length) headers.cookie = cookies.join('; ');
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {}
    const token = findToken(json);
    if (token) headers.authorization = `Bearer ${token}`;
    if (!headers.cookie && !headers.authorization) throw new Error(`Signing in as ${name} worked (${res.status}) but the answer had no token or cookie backlens recognises.`);
    held.set(name, { headers, at: Date.now() });
    return headers;
  }

  /** Forget held sign-ins (the app restarted with new secrets, or a replay got 401). */
  const forget = (name) => (name ? held.delete(name) : held.clear());

  /** Which role, if any, these request headers belong to (for labelling a baseline entry). */
  function roleOf(headers) {
    if (!headers) return null;
    for (const [name, h] of held) if ((h.headers.authorization && h.headers.authorization === headers.authorization) || (h.headers.cookie && h.headers.cookie === headers.cookie)) return name;
    return null;
  }

  return { headersFor, forget, roleOf };
}

/** A recorded request, re-addressed to a role: its auth headers swapped for the role's. */
export function asRole(payload, roleHeaders) {
  const headers = { ...payload.headers };
  delete headers.authorization;
  delete headers.cookie;
  return { ...payload, headers: { ...headers, ...roleHeaders } };
}
