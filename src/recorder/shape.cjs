'use strict';
/**
 * The shape of a JSON response: every path with the types seen there, never a value. Computed
 * inside the app, so values never leave it. Used by the behavior diff to notice a removed field or
 * a changed type.
 *
 *   { "items": [{ "id": 1, "tags": [] }], "next": null }
 *   -> { "$": "object", "$.items": "array", "$.items[]": "object", "$.items[].id": "number",
 *        "$.items[].tags": "array", "$.next": "null" }
 *
 * Several types at one path (array elements that differ) are joined: "number|string".
 */

const MAX_BODY = 1024 * 1024;
const MAX_PATHS = 400;
const MAX_DEPTH = 8;
const MAX_ITEMS = 20;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function walk(v, path, out, depth) {
  if (out.size >= MAX_PATHS) return;
  const t = typeOf(v);
  const seen = out.get(path);
  if (!seen) out.set(path, new Set([t]));
  else seen.add(t);
  if (depth >= MAX_DEPTH) return;
  if (t === 'array') for (const item of v.slice(0, MAX_ITEMS)) walk(item, `${path}[]`, out, depth + 1);
  else if (t === 'object') for (const k of Object.keys(v).sort()) walk(v[k], `${path}.${k}`, out, depth + 1);
}

/** The shape of a parsed JSON value, as { path: "type|type" }. */
function shapeOf(value) {
  const out = new Map();
  walk(value, '$', out, 0);
  const shape = {};
  for (const [path, types] of out) shape[path] = [...types].sort().join('|');
  if (out.size >= MAX_PATHS) shape['…'] = 'truncated';
  return shape;
}

/**
 * Collects a response body while it is written, for one request. Returns finish(), which gives the
 * shape (or null when the body is not JSON, too large, or compressed).
 */
function captureBody(res) {
  const chunks = [];
  let size = 0;
  let over = false;
  const keep = (chunk, encoding) => {
    if (over || chunk == null || typeof chunk === 'function') return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    size += buf.length;
    if (size > MAX_BODY) over = true;
    else chunks.push(buf);
  };
  const write = res.write;
  const end = res.end;
  res.write = function (chunk, encoding) {
    try {
      keep(chunk, encoding);
    } catch {}
    return write.apply(this, arguments);
  };
  res.end = function (chunk, encoding) {
    try {
      keep(chunk, encoding);
    } catch {}
    return end.apply(this, arguments);
  };
  return function finish() {
    try {
      const type = String(res.getHeader('content-type') || '');
      if (over || !/json/i.test(type) || res.getHeader('content-encoding')) return null;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return null;
      return shapeOf(JSON.parse(text));
    } catch {
      return null;
    }
  };
}

module.exports = { shapeOf, captureBody };
