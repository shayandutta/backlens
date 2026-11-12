import { checkTrace, dataWrites, normalizeSql } from '../analysis/index.js';
import { timing } from '../shared/compare.js';

/**
 * What one request did, without values: the fingerprint the behavior diff compares. Built from the
 * replays of one request (the same request sent a few times), the last of which gives everything
 * but time.
 */

const countBy = (list) => {
  const out = {};
  for (const k of list) out[k] = (out[k] || 0) + 1;
  return out;
};

const hostOf = (name) => {
  const m = String(name).match(/^\w+\s+(?:https?:\/\/)?([^/\s]+)/);
  return m ? m[1] : String(name).split(/\s+/)[0];
};

const at = (f) => (f ? `${f.file}:${f.line}` : 'unknown');

/**
 * Fingerprint of a request from its replayed traces (all with the same status). `ambient`: writes
 * every request makes (a rate limiter), left out of `writes`.
 */
export function fingerprint(traces, ambient = new Set()) {
  const last = traces.at(-1);
  const spans = last.spans || [];
  return {
    method: last.method,
    status: last.status,
    shape: last.shape || null,
    queries: countBy(spans.filter((s) => s.kind === 'db').map((s) => normalizeSql(s.name).slice(0, 200))),
    redis: countBy(spans.filter((s) => s.kind === 'redis').map((s) => String(s.name).split(/\s+/)[0].toUpperCase())),
    http: countBy(spans.filter((s) => s.kind === 'http').map((s) => hostOf(s.name))),
    errors: [...new Set(spans.filter((s) => s.error).map((s) => `${s.kind} ${normalizeSql(s.name).slice(0, 80)} at ${at((s.frames || [])[0])}`))],
    issues: [...new Set(checkTrace(last).map((i) => `${i.type}: ${i.title}`))],
    writes: dataWrites(last, ambient),
    time: timing(traces.map((t) => t.duration)),
  };
}
