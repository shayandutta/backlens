import { routeOf, summarize } from '../analysis/index.js';

/**
 * Everything the dashboard has recorded, in memory only: the app's traces (the last 1000), the last
 * test run's traces, the routes the app registered, index advice, the requests kept for replay, and
 * which issues a kept fix has hidden.
 */

export const KEEP = 1000;
export const KEEP_TEST = 5000;

export function createStore() {
  const traces = [];
  const testRun = { traces: [], report: null };
  const known = new Map();
  const advice = new Map();
  // Trace id -> the request itself (method, url, headers, body), for replaying it.
  const replays = new Map();
  // The same for requests the tests made, so measure_request works on a test-run request too.
  const testReplays = new Map();
  // Issue key -> when its fix was kept, and 'route:<route>' -> when code behind it changed (see summarize).
  const fixedAt = new Map();
  // Issue key -> the index created for it from the dashboard, so Undo still knows it.
  const createdIndexes = new Map();
  // 'METHOD url' -> the last warm measurement of that request (measure_request / measure_url), so
  // the next measurement compares warm against warm instead of against cold recorded traffic.
  const measured = new Map();
  let received = 0;

  const store = {
    traces,
    testRun,
    known,
    advice,
    replays,
    testReplays,
    fixedAt,
    createdIndexes,
    measured,
    // What the recorder in the running app hooked into (see recorder/adapters.cjs).
    adapters: null,
    get received() {
      return received;
    },
    knownRoutes: () => [...known.keys()],
    adviceList: () => [...advice.values()],

    /** Routes and issues of the app's traffic. withFixed: hide issues a kept fix removed. */
    summary: ({ withFixed = true } = {}) => summarize(traces, [...known.keys()], [...advice.values()], withFixed ? fixedAt : undefined),

    addTrace(trace, replay = null) {
      traces.push(trace);
      received++;
      if (replay) replays.set(trace.id, replay);
      if (traces.length > KEEP) replays.delete(traces.shift().id);
    },

    addTestTrace(trace, replay = null) {
      testRun.traces.push(trace);
      if (replay) testReplays.set(trace.id, replay);
      if (testRun.traces.length > KEEP_TEST) testReplays.delete(testRun.traces.shift().id);
    },

    /** The request behind a recorded trace (app or test traffic), for replaying it; null if not kept. */
    replayOf: (id) => replays.get(id) || testReplays.get(id) || null,

    findTrace: (id) => traces.find((t) => t.id === id) || testRun.traces.find((t) => t.id === id),

    /** Recorded requests on a route since the last fix kept there (the code they ran is the code being changed now), oldest first. */
    routeTraces(route) {
      const since = fixedAt.get(`route:${route}`) || 0;
      return traces.filter((t) => t.at > since && routeOf(t.method, t.url, t.template) === route);
    },

    /**
     * A fix was kept. The code behind this route changed: issues from its older requests point at
     * old lines, so they wait for a request on the new code (the after-fix one, or later).
     */
    markFixed(key, after) {
      const now = Date.now();
      fixedAt.set(key, now);
      fixedAt.set(`route:${key.split('|')[1]}`, now);
      if (after) {
        const { replayOf, ...trace } = after;
        store.addTrace({ ...trace, at: now + 1, afterFix: true });
      }
    },

    clear() {
      traces.length = 0;
      received = 0;
      advice.clear();
      fixedAt.clear();
    },
  };
  return store;
}
