import { r2 } from './stats.js';

/**
 * Honest timing comparisons. A timing is the median of warm runs with its spread (the middle half
 * of the runs, p25 to p75). Two timings differ only when the median moved by at least MIN_MS and
 * the two spreads do not overlap; otherwise the change is within noise and no percentage is
 * claimed. Query counts are exact and compared as they are.
 */

/** Below this a time change is not reported, however tight the runs. */
export const MIN_MS = 1;

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/** Median, middle half (lo-hi) and extremes of a list of durations in ms; null for an empty list. */
export function timing(durations) {
  const xs = durations.filter((d) => typeof d === 'number' && Number.isFinite(d)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  const ms = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return { ms: r2(ms), lo: r2(quantile(xs, 0.25)), hi: r2(quantile(xs, 0.75)), min: r2(xs[0]), max: r2(xs.at(-1)), runs: xs.length };
}

/**
 * Compares two timings from timing(). verdict: 'faster' | 'slower' | 'same' (within noise).
 * pct is null when the verdict is 'same', so no one quotes a percentage that is noise.
 */
export function compareTimings(before, after) {
  if (!before || !after) return null;
  const delta = r2(after.ms - before.ms);
  const apart = after.hi < before.lo || after.lo > before.hi;
  const verdict = Math.abs(delta) >= MIN_MS && apart ? (delta < 0 ? 'faster' : 'slower') : 'same';
  return { delta, pct: verdict === 'same' || !before.ms ? null : Math.round((delta / before.ms) * 100), verdict };
}

/** "5.6 ms (5.4-5.9, 5 runs)" */
export function timingText(t) {
  if (!t) return '-';
  return `${t.ms} ms (${t.lo}-${t.hi}, ${t.runs} run${t.runs === 1 ? '' : 's'})`;
}
