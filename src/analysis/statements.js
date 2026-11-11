/**
 * What a recorded call is: SQL normalising, the tables a statement touches, Redis key groups, and
 * whether a call only reads (and so may be moved to run alongside others).
 */

/** Strips literals, so queries that differ only in inlined values group together. */
export function normalizeSql(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/(?<![\w$])\d+(\.\d+)?\b/g, '?')
    .replace(/\bin\s*\((?:\s*(?:\?|\$\d+)\s*,?)+\)/gi, 'in (…)')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Redis reads whose repeats (same key, same arguments) count as the same call made twice. */
export const REDIS_REPEATABLE_READS = new Set(['GET', 'HGET', 'HGETALL', 'MGET', 'EXISTS', 'SMEMBERS', 'LRANGE', 'ZRANGE']);
/** Redis commands that only read, for deciding whether calls could run together. */
const REDIS_READ = new Set([...REDIS_REPEATABLE_READS, 'HMGET', 'SISMEMBER', 'ZSCORE', 'TTL', 'PTTL', 'STRLEN', 'HLEN', 'SCARD', 'ZCARD', 'LLEN', 'TYPE', 'SCAN']);
/** Redis commands drawn as reads on the map. */
export const REDIS_MAP_READS = new Set(['GET', 'MGET', 'HGET', 'HGETALL', 'HMGET', 'EXISTS', 'SMEMBERS', 'SISMEMBER', 'LRANGE', 'ZRANGE', 'ZSCORE', 'TTL', 'SCAN', 'KEYS']);

/** Only calls that read can be moved to run together: writes keep their order on purpose. */
export function isRead(span) {
  if (span.kind === 'db') return /^\s*(select|with)\b/i.test(span.name) && !/\b(insert|update|delete|merge)\b/i.test(span.name);
  if (span.kind === 'redis') return REDIS_READ.has(span.name.split(' ')[0]);
  if (span.kind === 'http') return /^(GET|HEAD) /.test(span.name);
  return false;
}

const WRITE_SQL = /^\s*(insert|update|delete|merge)\b/i;

/** Tables a statement touches, and whether it writes them. */
export function tablesOf(sql) {
  const tables = new Set();
  const re = /\b(?:from|join|into|update)\s+(?:only\s+)?"?([a-z_][\w$]*)"?(?:\s*\.\s*"?([a-z_][\w$]*)"?)?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = (m[2] || m[1]).toLowerCase();
    if (!['select', 'set', 'values', 'lateral', 'unnest', 'generate_series', 'json_each', 'jsonb_each'].includes(name)) tables.add(name);
  }
  return { tables: [...tables], write: WRITE_SQL.test(sql) };
}

/** rl:route:lesson-read:user:{id} → rl:route:*. Keys with values in them group by their first two parts. */
export function keyGroup(key) {
  const parts = String(key).split(':');
  if (parts.length <= 2) return key;
  return `${parts.slice(0, 2).join(':')}:*`;
}
