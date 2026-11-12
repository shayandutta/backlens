import { judge, readBaselineLenient, stableKey, trafficTotals } from '../report/index.js';

/** The report of the last test run started from the dashboard, judged against the baseline file. */
export function buildTestReport(store, exitCode, baselineFile) {
  const result = judge(store.testRun.traces, store.knownRoutes(), readBaselineLenient(baselineFile), { advice: store.adviceList() });
  const t = trafficTotals(store.testRun.traces);
  return {
    requests: t.requests,
    queries: t.queries,
    redis: t.redis,
    routesCalled: result.routes.filter((r) => r.calls).length,
    routesKnown: result.routes.length,
    exitCode,
    issues: result.issues.map((i) => ({ ...i, stableKey: stableKey(i) })),
    failing: result.failing.length,
  };
}
