import { routeOf } from './routes.js';
import { keyGroup, normalizeSql } from './statements.js';

/**
 * Writes a request made, as short signatures (no values): SQL that changes rows, Redis commands
 * that change keys, outgoing calls that are not GET/HEAD. Used to warn that replaying a "read"
 * changes data, to keep such routes out of the behavior diff's baseline, and to notice a read that
 * starts writing after a change.
 *
 * Writes that happen on nearly every request across routes (a rate limiter, a session touch) are
 * infrastructure, not the route's behavior: ambientWrites() finds them so they can be ignored.
 */

const SQL_WRITE = /^\s*(insert|update|delete|merge|truncate|alter|create|drop)\b|^\s*with\b[\s\S]*\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;
// Commands that neither read data nor write it.
const REDIS_NEUTRAL = new Set(['MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH', 'PING', 'AUTH', 'HELLO', 'SELECT', 'CLIENT', 'INFO', 'QUIT']);
const REDIS_READ = new Set(['GET', 'MGET', 'HGET', 'HGETALL', 'HMGET', 'HKEYS', 'HVALS', 'HEXISTS', 'EXISTS', 'SMEMBERS', 'SISMEMBER', 'SCARD', 'LRANGE', 'LLEN', 'LINDEX', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZSCORE', 'ZCARD', 'ZRANK', 'TTL', 'PTTL', 'STRLEN', 'HLEN', 'TYPE', 'SCAN', 'KEYS', 'GETRANGE', 'MEMORY', 'DBSIZE']);

/** The write signature of one span, or null when it does not write. */
export function writeOf(span) {
  const name = String(span.name || '');
  if (span.kind === 'db') return SQL_WRITE.test(name) ? `db ${normalizeSql(name).slice(0, 80)}` : null;
  if (span.kind === 'redis') {
    const cmd = name.split(/\s+/)[0].toUpperCase();
    if (REDIS_READ.has(cmd) || REDIS_NEUTRAL.has(cmd)) return null;
    const key = name.split(/\s+/)[1];
    return `redis ${cmd}${key ? ` ${keyGroup(key)}` : ''}`;
  }
  if (span.kind === 'http') {
    const m = name.match(/^([A-Z]+)\s+(?:https?:\/\/)?([^/\s]+)/);
    return m && !['GET', 'HEAD', 'OPTIONS'].includes(m[1]) ? `http ${m[1]} ${m[2]}` : null;
  }
  return null;
}

/**
 * The distinct writes of a trace. `redis: false` leaves out Redis writes: from a read they are
 * nearly always a cache fill or a rate-limit counter (seen on a real app: per-route rate-limit
 * keys and cache SETs), not data the read changes.
 */
export const writesOf = (trace, { redis = true } = {}) => [...new Set((trace.spans || []).filter((s) => redis || s.kind !== 'redis').map(writeOf).filter(Boolean))];

/**
 * Writes made by nearly every request, on several routes: infrastructure (rate limiting, sessions).
 * Needs at least 5 requests on 2 routes to judge; below that, nothing is ambient.
 */
export function ambientWrites(traces, { share = 0.8 } = {}) {
  const reads = traces.filter((t) => ['GET', 'HEAD'].includes(t.method));
  if (reads.length < 5) return new Set();
  const count = new Map();
  const routes = new Map();
  for (const t of reads) {
    for (const w of writesOf(t)) {
      count.set(w, (count.get(w) || 0) + 1);
      if (!routes.has(w)) routes.set(w, new Set());
      routes.get(w).add(routeOf(t.method, t.url, t.template));
    }
  }
  return new Set([...count].filter(([w, n]) => n / reads.length >= share && routes.get(w).size >= 2).map(([w]) => w));
}

/** The writes of a trace that are its own, not infrastructure. */
export const ownWrites = (trace, ambient, options) => writesOf(trace, options).filter((w) => !ambient.has(w));

/** Writes that change data: SQL and outgoing calls. What keeps a read out of the diff. */
export const dataWrites = (trace, ambient) => ownWrites(trace, ambient, { redis: false });
