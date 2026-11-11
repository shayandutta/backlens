import { buildContext } from './context.js';
import { looksLikeKey, removeKey, saveKey } from './credentials.js';
import { createFixJobs } from './fix-jobs.js';
import { anthropicStatus, ask, ollamaStatus, startPull, stopPull, testKey } from './providers/index.js';
import { route } from './router.js';
import { createSettings } from './settings.js';

export { cleanCode } from './edits.js';

/**
 * Explain and Fix, for one project. deps come from the dashboard:
 *   root, pm, config(), readProject(), appCommand(), appPort(), pauseWatch(on), testsTail(),
 *   getIssue(key), getTrace(id), getReplay(id), routeTraces(route), markFixed(key, after),
 *   restartApp(), runTests(), replayer ({ send(payload, port, id) }, see dashboard/replay.js).
 */
export function createAI(deps) {
  const { root } = deps;
  const settings = createSettings(root);
  const fixes = createFixJobs({ root, deps, settings });

  async function status() {
    return {
      settings: await settings.resolved(),
      configured: Boolean(settings.get().provider),
      ollama: await ollamaStatus(),
      anthropic: anthropicStatus(),
      spentTodayUsd: settings.spentToday(),
      history: settings.history().length,
    };
  }

  async function explain(issueKey) {
    const issue = deps.getIssue(issueKey);
    if (!issue) throw new Error('That issue is gone. Refresh the list.');
    const ctx = buildContext(root, issue);
    const s = await settings.resolved();
    const routeInfo = route({ task: 'explain', issue, ctx, settings: s, hasTests: Boolean(deps.config()?.test) });
    settings.guardBudget(routeInfo);
    const result = await ask({ task: 'explain', issue, ctx, routeInfo, root });
    settings.recordUsage('explain', routeInfo, result.costUsd);
    return { ...result.data, by: routeInfo.label, costUsd: result.costUsd || 0 };
  }

  /** Tests a pasted key (free) and saves it only if Claude accepts it. */
  async function setKey(key) {
    key = typeof key === 'string' ? key.trim() : '';
    if (!looksLikeKey(key)) throw new Error('That does not look like a Claude API key. It starts with sk-ant-.');
    const problem = await testKey(key);
    if (problem) throw new Error(problem);
    saveKey(key);
    return status();
  }

  async function forgetKey() {
    removeKey();
    return status();
  }

  async function pullModel(model) {
    startPull(model);
    return status();
  }

  async function stopPullModel() {
    stopPull();
    return status();
  }

  return {
    status,
    saveSettings: (next) => settings.save(next),
    replayEnabled: () => settings.get().replay,
    explain,
    setKey,
    forgetKey,
    pullModel,
    stopPullModel,
    ...fixes,
  };
}
