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
  function send(payload, port, id, extraHeaders = null) {
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
      const req = http.request({ host: '127.0.0.1', port, method: payload.method, path: payload.url, headers: { ...payload.headers, ...extraHeaders, 'x-backlens-replay': id } });
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

  /**
   * Warm-up, then measured runs: the traces of the measured ones. Used by measure_request and fix
   * verification. A just-started app keeps getting faster for a while (JIT, connection pools,
   * caches), and a fixed few warm-ups were seen to leave it half warm, which made the same code look
   * 47% faster on the next measurement. So warm-ups run in windows of `warmups` requests until a
   * window's median is no longer clearly faster than the one before (or `maxWarmups` is reached).
   */
  async function measure(payload, port, { warmups = REPLAY.warmups, maxWarmups = REPLAY.maxWarmups, samples = REPLAY.samples } = {}) {
    const id = randomUUID();
    const windowMedian = async () => {
      const ds = [];
      for (let i = 0; i < warmups; i++) {
        const t = await send(payload, port, id);
        if (t) ds.push(t.duration);
      }
      return ds.length ? ds.sort((a, b) => a - b)[Math.floor(ds.length / 2)] : null;
    };
    let prev = await windowMedian();
    for (let done = warmups; prev != null && done + warmups <= maxWarmups; done += warmups) {
      const cur = await windowMedian();
      if (cur == null || cur >= prev * REPLAY.settled) break;
      prev = cur;
    }
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
