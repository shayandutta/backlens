import http from 'node:http';
import { ambientWrites, dataWrites, routeOf } from '../analysis/index.js';
import { SAFE_METHODS } from '../shared/replay-policy.js';
import { timing } from '../shared/compare.js';

/**
 * `backlens doctor`: can backlens's numbers be trusted on this app?
 *
 * 1. Adapters: what the recorder hooked into, with versions, and whether each is on a tested
 *    version or shares its methods with another instrumentation tool.
 * 2. Overhead: what recording itself costs a request. The same recorded reads are sent alternately
 *    with recording on and with recording off (`x-backlens: skip`), timed from outside the app the
 *    same way, after a warm-up. Alternating keeps drift (a warming JIT, a busy machine) from
 *    landing on one side only.
 */

const ROUTES = 2;
const WARMUPS = 4;
const PAIRS = 12;

/** Sends one request and resolves with its wall time in ms and status (null on error). */
function timed(port, payload, headers) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, method: payload.method, path: payload.url, headers: { ...payload.headers, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, status: res.statusCode }));
    });
    req.setTimeout(15000, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** The most-called recorded reads that did not change data, one per route. */
function pick(store) {
  const ambient = ambientWrites(store.traces);
  const calls = new Map();
  const newest = new Map();
  for (let i = store.traces.length - 1; i >= 0; i--) {
    const t = store.traces[i];
    const route = routeOf(t.method, t.url, t.template);
    calls.set(route, (calls.get(route) || 0) + 1);
    if (newest.has(route) || t.status >= 400) continue;
    const payload = store.replays.get(t.id);
    if (!payload || !SAFE_METHODS.includes(payload.method) || dataWrites(t, ambient).length) continue;
    newest.set(route, { route, payload });
  }
  return [...newest.values()].sort((a, b) => calls.get(b.route) - calls.get(a.route)).slice(0, ROUTES);
}

export async function runDoctor({ store, procs }) {
  const adapters = store.adapters ? store.adapters.list : [];
  const port = procs() ? await procs().appPort() : null;
  const out = { adapters, recorderSeen: Boolean(store.adapters), overhead: [], notes: [] };
  if (!port) {
    out.notes.push('The app is not running, so the cost of recording was not measured.');
    return out;
  }
  const picked = pick(store);
  if (!picked.length) out.notes.push('No recorded read to measure with yet: use the app once, then run doctor again.');
  for (const { route, payload } of picked) {
    const on = { 'x-backlens-replay': `doctor-${Date.now()}` };
    const off = { 'x-backlens': 'skip' };
    for (let i = 0; i < WARMUPS; i++) {
      await timed(port, payload, on);
      await timed(port, payload, off);
    }
    const a = [];
    const b = [];
    let odd = 0;
    for (let i = 0; i < PAIRS; i++) {
      // Alternate which goes first, so neither side always gets the warmer slot.
      const order = i % 2 ? [[off, b], [on, a]] : [[on, a], [off, b]];
      for (const [headers, list] of order) {
        const r = await timed(port, payload, headers);
        if (r && r.status < 400) list.push(r.ms);
        else odd++;
      }
    }
    const rec = timing(a);
    const bare = timing(b);
    if (!rec || !bare) {
      out.notes.push(`${route}: the app did not answer normally (${odd} odd answers), so it was not measured.`);
      continue;
    }
    const ms = Math.round((rec.ms - bare.ms) * 100) / 100;
    out.overhead.push({ route, recording: rec, bare, ms, pct: bare.ms ? Math.round((ms / bare.ms) * 100) : null, odd });
  }
  return out;
}
