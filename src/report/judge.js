import { summarize } from '../analysis/index.js';
import { stableKey } from './baseline.js';

/**
 * Splits issues into new and known, and decides whether the run fails: a new warning fails it,
 * and with `strict` a new hint does too. A finding whose confidence is only "check" (backlens
 * itself doubts it) never fails a build on its own: it is reported, and `strict` still counts it.
 */
export function judge(traces, known, baseline, { strict = false, advice = [] } = {}) {
  const { routes, issues } = summarize(traces, known, advice);
  const marked = issues.map((i) => ({ ...i, isNew: !baseline.has(stableKey(i)) }));
  const doubted = (i) => i.confidence && i.confidence.level === 'check';
  const failing = marked.filter((i) => i.isNew && (strict || (i.severity === 'warn' && !doubted(i))));
  return { routes, issues: marked, failing };
}

/** Totals for a set of traces: requests and calls by kind. */
export function trafficTotals(traces) {
  const calls = (kind) => traces.reduce((n, t) => n + t.spans.filter((s) => s.kind === kind).length, 0);
  return { requests: traces.length, queries: calls('db'), redis: calls('redis'), http: calls('http') };
}
