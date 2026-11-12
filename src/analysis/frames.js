import { normalizeSql } from './statements.js';

/**
 * Call sites. Each recorded span carries the app frames that led to it (innermost first); these
 * helpers turn them into file:line locations and answer "where did two calls part" and "which
 * function awaited both".
 */

/** The innermost app frame of a span. */
export const where = (span) => (span.frames && span.frames[0]) || null;

/** file:line of a frame. */
export const at = (f) => (f ? `${f.file}:${f.line}` : 'unknown');

/** Where two calls' code paths part: the first frame that differs in each. */
export function splitSites(a, b) {
  const fa = a.frames || [];
  const fb = b.frames || [];
  for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
    const x = fa[i];
    const y = fb[i];
    if (x.file !== y.file || x.line !== y.line || x.fn !== y.fn) return [x, y];
  }
  return [fa[0] || null, fb[0] || null];
}

/**
 * The function two calls were awaited in: a frame both stacks share (same function, same callers
 * above it) at different lines. signup → take → eval twice is awaited in signup; mine() awaiting a
 * query directly and then this.eligible() (which queries) is awaited in mine.
 */
export function awaitedIn(a, b) {
  const fa = a.frames || [];
  const fb = b.frames || [];
  const same = (x, y) => x.fn === y.fn && x.file === y.file;
  const sameAbove = (i, j) => {
    const n = Math.min(fa.length - i - 1, fb.length - j - 1);
    for (let k = 1; k <= n; k++) if (!same(fa[i + k], fb[j + k]) || fa[i + k].line !== fb[j + k].line) return false;
    return true;
  };
  for (let i = 0; i < fa.length; i++) {
    for (let j = 0; j < fb.length; j++) {
      if (same(fa[i], fb[j]) && fa[i].line !== fb[j].line && sameAbove(i, j)) return fa[i];
    }
  }
  return null;
}

/**
 * Lines that many different statements pass through are wrappers (a pool.query or logging helper),
 * not where the app made the call. Returns the set of such file:line keys for these spans.
 */
export function wrapperLines(spans) {
  const throughLine = new Map();
  for (const s of spans) {
    const f = s.frames && s.frames[0];
    if (!f) continue;
    const key = `${f.file}:${f.line}`;
    if (!throughLine.has(key)) throughLine.set(key, new Set());
    throughLine.get(key).add(normalizeSql(s.name));
  }
  return new Set([...throughLine].filter(([, names]) => names.size >= 2).map(([key]) => key));
}

/** Drops leading wrapper frames, keeping at least one, so locations point at the real code. */
export function stripWrappers(frames, wrappers) {
  const out = [...(frames || [])];
  while (out.length > 1 && wrappers.has(`${out[0].file}:${out[0].line}`)) out.shift();
  return out;
}
