import { isAbsolute, normalize } from 'node:path';

/**
 * The counterfactual lab's pure parts: checking and applying a proposed fix's edits, and ranking
 * the measured fixes.
 *
 * A fix is { name, edits: [{ file, find, replace }] }: each `find` must occur exactly once in its
 * file (as it is now, after the earlier edits of the same fix), like an editor's exact replace.
 */

export const MAX_FIXES = 4;

/** A problem with the fixes as given, or null. */
export function checkFixes(fixes) {
  if (!Array.isArray(fixes) || !fixes.length) return 'Give 1 to 4 fixes: [{ name, edits: [{ file, find, replace }] }].';
  if (fixes.length > MAX_FIXES) return `At most ${MAX_FIXES} fixes per run.`;
  const names = new Set();
  for (const [i, f] of fixes.entries()) {
    const label = f && f.name ? `"${f.name}"` : `fix ${i + 1}`;
    if (!f || typeof f.name !== 'string' || !f.name.trim()) return `${label} needs a name.`;
    if (names.has(f.name)) return `Two fixes are named "${f.name}".`;
    names.add(f.name);
    if (!Array.isArray(f.edits) || !f.edits.length) return `${label} has no edits.`;
    for (const e of f.edits) {
      if (!e || typeof e.file !== 'string' || typeof e.find !== 'string' || typeof e.replace !== 'string') return `${label}: each edit needs file, find and replace (strings).`;
      if (!e.find) return `${label}: an edit's find is empty.`;
      const p = normalize(e.file);
      if (isAbsolute(p) || p.startsWith('..') || p.split(/[\\/]/).includes('node_modules') || p.startsWith('.backlens')) return `${label}: ${e.file} is not a file of the project.`;
    }
  }
  return null;
}

/** Applies a fix to { file: text }: { files: { file: newText } } or { error }. */
export function applyFix(fix, read) {
  const out = {};
  for (const e of fix.edits) {
    const file = normalize(e.file);
    const text = file in out ? out[file] : read(file);
    if (text == null) return { error: `"${fix.name}": ${e.file} does not exist.` };
    const at = text.indexOf(e.find);
    if (at === -1) return { error: `"${fix.name}": the text to replace was not found in ${e.file}.` };
    if (text.indexOf(e.find, at + 1) !== -1) return { error: `"${fix.name}": the text to replace occurs more than once in ${e.file}; include more context.` };
    out[file] = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  }
  return { files: out };
}

/**
 * Ranks measured fixes against the code as it is. A fix qualifies when it ran, answered with the
 * same status, broke no route in the behavior diff and did not fail the tests (when they ran).
 * Then: fewer queries wins; on equal queries, a time faster beyond noise (the p25-p75 ranges do
 * not overlap). Returns { winner: name | null, why, order: [names] }.
 */
export function rankFixes(base, trials) {
  const ok = trials.filter((t) => !t.error && t.status === base.status && !t.broken && t.tests !== false);
  const faster = (a, b) => a.hi < b.lo;
  const better = (t) => t.queries < base.queries || (t.queries === base.queries && faster(t, base));
  const order = [...ok].sort((a, b) => a.queries - b.queries || a.ms - b.ms);
  const best = order.find(better);
  if (!best) return { winner: null, order: order.map((t) => t.name), why: ok.length ? 'no fix used fewer queries or ran clearly faster than the code as it is' : 'every fix failed, broke a route or changed the answer' };
  const dq = base.queries - best.queries;
  return { winner: best.name, order: order.map((t) => t.name), why: dq > 0 ? `${dq} fewer queries per request (${base.queries} -> ${best.queries})` : `faster beyond noise (${base.ms} -> ${best.ms} ms, ranges do not overlap)` };
}
