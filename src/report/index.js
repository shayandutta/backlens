/** The CI report: baseline of known issues, judging a run against it, and the terminal output. */
export { acceptIntoBaseline, readBaseline, readBaselineLenient, stableKey, writeBaseline } from './baseline.js';
export { format } from './format.js';
export { judge, trafficTotals } from './judge.js';
