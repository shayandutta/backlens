import { percentile, r1 } from '../shared/stats.js';
import { checkTrace } from './check-trace.js';
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
      if (!issues.has(key)) issues.set(key, { ...issue, key, route, seen: 0, example: trace.id, costTotal: 0 });
      const agg = issues.get(key);
      agg.seen++;
      agg.costTotal += issue.cost;
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
    .map((i) => ({ ...i, of: routes.get(i.route).calls, cost: r1(i.costTotal / i.seen) }))
    .sort((a, b) => (a.severity === b.severity ? b.seen * b.cost - a.seen * a.cost : a.severity === 'warn' ? -1 : 1));
  return { routes: routeList, issues: issueList };
}
