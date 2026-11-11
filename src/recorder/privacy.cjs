'use strict';
/**
 * Values never leave the app. Query parameters and results become short hashes, which are enough
 * to tell two identical calls from two different ones and to see that a later call used a value an
 * earlier one returned. Redis keys have personal data masked.
 */

const { createHash } = require('node:crypto');

/** Keys often carry personal data: rl:login:email:ada@x.com becomes rl:login:email:{email}. */
function redact(text) {
  return String(text)
    .replace(/[^\s:@]+@[^\s:@]+\.[^\s:@]+/g, '{email}')
    .replace(/(?:::ffff:)?\b\d{1,3}(?:\.\d{1,3}){3}\b/gi, '{ip}')
    .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){4,7}\b/gi, '{ip}')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')
    .replace(/\b\d{6,}\b/g, '{n}');
}

/** One hash of all of a call's values. */
function hashValues(values) {
  if (values === undefined) return null;
  try {
    const json = JSON.stringify(values, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    return createHash('sha1').update(json).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Fingerprints of single values: each parameter a query was given, and the values in the rows it
 * returned. If a later query's parameter matches a value an earlier one returned, it depends on
 * it, and the two cannot run together. Only short hashes are kept, never the values.
 */
const fp = (v) => createHash('sha1').update(String(v)).digest('hex').slice(0, 10);
const scalar = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200) || typeof v === 'number' || typeof v === 'bigint';

function paramPrints(params) {
  if (!Array.isArray(params)) return undefined;
  const out = new Set();
  for (const p of params) for (const v of Array.isArray(p) ? p : [p]) if (scalar(v) && out.size < 60) out.add(fp(v));
  return out.size ? [...out] : undefined;
}

function resultPrints(rows) {
  if (!Array.isArray(rows) || !rows.length) return undefined;
  const out = new Set();
  for (const row of rows.slice(0, 200)) {
    if (!row || typeof row !== 'object') continue;
    for (const v of Object.values(row)) if (scalar(v) && out.size < 400) out.add(fp(v));
  }
  return out.size ? [...out] : undefined;
}

/** The scalar values inside an ORM call's arguments (nested objects and arrays), for paramPrints. */
function scalarsOf(value, out = [], depth = 0) {
  if (out.length >= 60 || depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'object') {
    if (value instanceof Date) out.push(value.toISOString());
    else for (const v of Array.isArray(value) ? value : Object.values(value)) scalarsOf(v, out, depth + 1);
  } else out.push(value);
  return out;
}

module.exports = { redact, hashValues, paramPrints, resultPrints, scalarsOf };
