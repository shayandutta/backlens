/**
 * Fresh app runs for measuring. On a dev machine a process that has served hundreds of requests
 * answers the same code about twice as fast as a fresh one, and a code change restarts the app, so
 * a before and an after are only comparable when both come from a fresh run. A run stays fresh
 * until something has measured on it or it has served more than FRESH_REQUESTS requests.
 */

export const FRESH_REQUESTS = 50;

export function createFreshness({ store, procs }) {
  // App runs (their startedAt) that a measurement or a behavior check already used.
  const used = new Set();

  /**
   * The app's port on a fresh run, restarting it when needed: { port, restarted, run }.
   * maxRequests: how much traffic a run may have served and still count (0: none at all, which
   * the behavior diff uses so its baseline and its checks start from the same state).
   */
  async function freshRun({ maxRequests = FRESH_REQUESTS } = {}) {
    const p = procs();
    let port = await p.appPort();
    const run = p.app.startedAt;
    const stale = used.has(run) || store.traces.filter((t) => t.at >= run).length > maxRequests;
    let restarted = false;
    if (!port || stale) {
      port = await p.restartApp();
      restarted = true;
    }
    return { port, restarted, run: p.app.startedAt };
  }

  /** Marks a run as used: the next measurement restarts first. */
  const markUsed = (run) => used.add(run);

  return { freshRun, markUsed };
}
