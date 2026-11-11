import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { REPLAY } from '../shared/replay-policy.js';

/**
 * Replaying recorded requests against the app as it runs now. A replay carries an
 * x-backlens-replay id; the recorder reports its trace like any other, and the dashboard hands it
 * back here (onTrace) instead of adding it to the normal numbers.
 */
export function createReplayer() {
  const waiters = new Map();

  /** Sends one request and resolves with its trace, or null if none came back in time. */
  function send(payload, port, id) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        resolve(null);
      }, REPLAY.timeoutMs);
      waiters.set(id, (trace) => {
        clearTimeout(timer);
        waiters.delete(id);
        resolve(trace);
      });
      const req = http.request({ host: '127.0.0.1', port, method: payload.method, path: payload.url, headers: { ...payload.headers, 'x-backlens-replay': id } });
      req.on('error', () => {});
      if (payload.body) req.write(Buffer.from(payload.body, 'base64'));
      req.end();
    });
  }

  /** Called by the server when a replayed request's trace arrives. */
  function onTrace(trace) {
    const waiter = waiters.get(trace.replayOf);
    if (waiter) waiter(trace);
  }

  /** Warm-up runs, then measured runs: the traces of the measured ones. Used by measure_request. */
  async function measure(payload, port, { warmups = REPLAY.warmups, samples = REPLAY.samples } = {}) {
    const id = randomUUID();
    for (let i = 0; i < warmups; i++) await send(payload, port, id);
    const out = [];
    for (let i = 0; i < samples; i++) {
      const t = await send(payload, port, id);
      if (!t) break;
      out.push(t);
    }
    return out;
  }

  return { send, onTrace, measure };
}

/** Sends a recorded read to the app without recording it, so the app opens its connections. */
export function warmUp(port, payload) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method: payload.method, path: payload.url, headers: { ...payload.headers, 'x-backlens': 'skip' } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    r.setTimeout(REPLAY.timeoutMs, () => r.destroy());
    r.on('error', resolve);
    r.on('close', resolve);
    r.end();
  });
}
