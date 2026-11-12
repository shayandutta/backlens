import { r1 } from '../../shared/stats.js';
import { at, awaitedIn, where } from '../frames.js';
import { isRead } from '../statements.js';

/**
 * serial: calls from one function awaited back to back, which could run together if they do not
 * depend on each other. A hint, since backlens cannot see every dependency.
 *
 * `io` are the request's spans with wrapper frames stripped; `covered` are spans another check
 * already reported (repeats, N+1), which are left out here.
 */

const sum = (list) => list.reduce((n, s) => n + s.duration, 0);

/** A call that takes a value an earlier call returned depends on it: they cannot run together. */
function dependsOn(later, earlier) {
  if (!later.took || !earlier.gave) return false;
  const gave = new Set(earlier.gave);
  return later.took.some((v) => gave.has(v));
}

export function findSerial(io, covered) {
  const issues = [];
  const ordered = io.filter((s) => !covered.has(s) && where(s)).sort((a, b) => a.start - b.start);
  let run = [];
  let fnOfRun = null;
  const flush = () => {
    if (run.length >= 2 && sum(run) >= 0.3 && fnOfRun) {
      const f = fnOfRun;
      issues.push({
        type: 'serial',
        severity: 'hint',
        title: `${run.length} calls in ${f.fn} wait for each other`,
        fix: 'If none of them needs the result of another, start them together with Promise.all.',
        sql: run.map((s) => s.name.slice(0, 80)).join('\n'),
        sites: [...new Set(run.map((s) => at((s.frames || []).find((x) => x.fn === f.fn && x.file === f.file))))],
        frames: [run[0].frames],
        cost: r1(sum(run) - Math.max(...run.map((s) => s.duration))),
        // Whether backlens could check the calls do not feed each other (value fingerprints on both sides).
        evidence: {
          dependencyChecked: run.every((s) => Array.isArray(s.took) || Array.isArray(s.gave)),
          // A call that takes a lock must come first: the others run under it on purpose.
          lock: run.some((s) => /\bfor\s+(update|share|no\s+key\s+update)\b|pg_(try_)?advisory|\block\s+table\b/i.test(s.name)),
          // An earlier call that found nothing: the later one may be a fallback that only runs then.
          fallback: run.slice(0, -1).some((s) => s.rows === 0),
        },
      });
    }
    run = [];
  };
  for (const s of ordered) {
    if (!isRead(s)) {
      // A write between calls pins their order: nothing on either side may move across it.
      flush();
      fnOfRun = null;
      continue;
    }
    const prev = run[run.length - 1];
    const shared = prev ? awaitedIn(prev, s) : null;
    // Same kind only: a cache read then a database load is cache-aside, and the load depends on the miss.
    const sameFn = Boolean(shared) && prev.kind === s.kind && (!fnOfRun || (shared.fn === fnOfRun.fn && shared.file === fnOfRun.file));
    if (sameFn && run.length === 1) fnOfRun = shared;
    const afterPrev = prev && s.start >= prev.start + prev.duration - 0.05;
    const overlapsAny = ordered.some((o) => o !== s && o.start < s.start + s.duration && s.start < o.start + o.duration);
    const dependent = run.some((r) => dependsOn(s, r));
    if (prev && sameFn && afterPrev && !overlapsAny && !dependent) run.push(s);
    else {
      flush();
      fnOfRun = null;
      if (!overlapsAny) run = [s];
    }
  }
  flush();
  return issues;
}
