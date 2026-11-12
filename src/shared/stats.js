/** Rounds to one decimal. */
export const r1 = (n) => Math.round(n * 10) / 10;

/** Rounds to two decimals. */
export const r2 = (n) => Math.round(n * 100) / 100;

/** The p-th percentile (0-100) of a list of numbers, nearest-rank; 0 for an empty list. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** The median, averaging the two middle values of an even-length list, rounded to two decimals. */
export function median(list) {
  const xs = [...list].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return r2(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
}

/** The lower median (no averaging), rounded to two decimals; null for an empty list. */
export function lowerMedian(list) {
  const v = [...list].sort((a, b) => a - b);
  return v.length ? r2(v[Math.floor((v.length - 1) / 2)]) : null;
}
