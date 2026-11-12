import { median, percentile, r1 } from '../shared/stats.js';
import { checkTrace } from './check-trace.js';
import { confidenceOf } from './confidence.js';
import { indexIssues } from './index-advice.js';
import { routeOf } from './routes.js';

const emptyRoute = (route) => ({ route, calls: 0, durations: [], queries: 0, redis: 0, http: 0, errors: 0, issueKeys: new Set(), last: 0 });

/**
 * Routes and issues across every trace kept.
 *
 * known:  routes the app registered, listed even when nobody called them yet.
 * advice: index advice from the recorder (see index-advice.js).
 * fixed:  issue key -> when a fix for it was kept, and 'route:<route>' -> when code behind that
 *         route changed. Such issues are hidden until a request after that moment shows them again.
 */
/**
 * One issue's evidence over every request it was seen in: a doubt in any request stays (a call with
 * no code location, copies overlapping, a write between), a check passes only if it passed in all,
 * and counts keep their largest.
 */
function mergeEvidence(a, b) {
  if (!a) return b ? { ...b } : b;
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = Math.max(out[k] ?? v, v);
    else if (k === 'located' || k === 'dependencyChecked') out[k] = Boolean(out[k] ?? true) && v;
    else if (typeof v === 'boolean') out[k] = Boolean(out[k]) || v;
    else out[k] = v;
  }
  return out;
}

export function summarize(traces, known = [], advice = [], fixed = new Map()) {
  const routes = new Map();
  const issues = new Map();
  for (const trace of traces) {
    const route = routeOf(trace.method, trace.url, trace.template);
    if (!routes.has(route)) routes.set(route, emptyRoute(route));
    const r = routes.get(route);
    r.calls++;
    r.durations.push(trace.duration);
    r.queries += trace.spans.filter((s) => s.kind === 'db').length;
    r.redis += trace.spans.filter((s) => s.kind === 'redis').length;
    r.http += trace.spans.filter((s) => s.kind === 'http').length;
    if (trace.status >= 500) r.errors++;
    r.last = Math.max(r.last, trace.at);

    for (const issue of checkTrace(trace)) {
      const key = `${issue.type}|${route}|${issue.sql}|${issue.sites.join(',')}`;
      r.issueKeys.add(key);
      if (!issues.has(key)) issues.set(key, { ...issue, evidence: null, key, route, seen: 0, example: trace.id, costs: [] });
      const agg = issues.get(key);
      agg.seen++;
      agg.costs.push(issue.cost);
      agg.evidence = mergeEvidence(agg.evidence, issue.evidence);
      agg.example = trace.id;
      agg.lastAt = Math.max(agg.lastAt || 0, trace.at || 0);
    }
  }

  for (const issue of indexIssues(traces, advice)) {
    routes.get(issue.route)?.issueKeys.add(issue.key);
    issues.set(issue.key, issue);
  }

  for (const route of known) if (!routes.has(route)) routes.set(route, emptyRoute(route));

  for (const [key, issue] of issues) {
    const since = Math.max(fixed.get(key) || 0, fixed.get(`route:${issue.route}`) || 0);
    if (since && since >= (issue.lastAt || 0)) {
      issues.delete(key);
      routes.get(issue.route)?.issueKeys.delete(key);
    }
  }

  const routeList = [...routes.values()]
    .map((r) => ({
      route: r.route,
      calls: r.calls,
      p50: percentile(r.durations, 50),
      p95: percentile(r.durations, 95),
      queries: r.calls ? r1(r.queries / r.calls) : 0,
      redis: r.calls ? r1(r.redis / r.calls) : 0,
      http: r.calls ? r1(r.http / r.calls) : 0,
      errors: r.errors,
      issues: r.issueKeys.size,
      last: r.last,
    }))
    .sort((a, b) => b.last - a.last || a.route.localeCompare(b.route));
  const issueList = [...issues.values()]
    // The median, not the mean: the first requests after a start are cold (empty pools, unjitted
    // code) and would inflate an average. Still an estimate from recorded traffic: measure to confirm.
    .map(({ costs, ...i }) => ({ ...i, of: routes.get(i.route).calls, cost: costs && costs.length ? r1(median(costs)) : i.cost || 0 }))
    .map((i) => ({ ...i, confidence: confidenceOf(i) }))
    .sort((a, b) => (a.severity === b.severity ? b.seen * b.cost - a.seen * a.cost : a.severity === 'warn' ? -1 : 1));
  return { routes: routeList, issues: issueList };
}
