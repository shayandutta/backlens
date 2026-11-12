import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureIgnore, projectDir } from '../shared/project-config.js';
import { LOCAL_MODELS, ollamaStatus } from './providers/index.js';

/**
 * AI settings for a project (.backlens/ai.json), what was spent (ai-usage.jsonl) with the daily
 * budget enforced before anything paid is sent, and the history of fixes (ai-history.jsonl) the
 * router learns from.
 */

// Replaying a write sends it again, so it changes the dev database twice: reads only unless asked.
export const DEFAULTS = { provider: null, ollamaModel: null, dailyBudgetUsd: 1, replay: true, replayWrites: false };

export function createSettings(root) {
  const dir = projectDir(root);
  const settingsFile = join(dir, 'ai.json');
  const usageFile = join(dir, 'ai-usage.jsonl');
  const historyFile = join(dir, 'ai-history.jsonl');

  const readLines = (file) => {
    try {
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const append = (file, row) => {
    mkdirSync(dir, { recursive: true });
    ensureIgnore(root);
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  };

  let settings = { ...DEFAULTS };
  try {
    settings = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsFile, 'utf8')) };
  } catch {}

  /** Settings with the provider and local model filled in when the user has not picked them. */
  async function resolved() {
    const local = await ollamaStatus();
    // No model picked yet: one already downloaded if there is one, else the size this machine suits.
    const ollamaModel =
      settings.ollamaModel || LOCAL_MODELS.map((m) => m.name).find((n) => local.models.includes(n)) || local.models.find((n) => /coder/.test(n)) || local.recommended;
    // Nothing is ever paid by default: the local model if it is ready, recorded answers otherwise.
    const provider = settings.provider || (local.running && local.models.includes(ollamaModel) ? 'ollama' : 'mock');
    return { ...settings, ollamaModel, provider };
  }

  function save(next) {
    settings = {
      provider: ['mock', 'ollama', 'anthropic'].includes(next.provider) ? next.provider : settings.provider,
      ollamaModel: typeof next.ollamaModel === 'string' && /^[\w.:/-]{1,80}$/.test(next.ollamaModel) ? next.ollamaModel : settings.ollamaModel,
      dailyBudgetUsd: Number.isFinite(Number(next.dailyBudgetUsd)) && Number(next.dailyBudgetUsd) >= 0 ? Number(next.dailyBudgetUsd) : settings.dailyBudgetUsd,
      replay: next.replay === undefined ? settings.replay : Boolean(next.replay),
      replayWrites: next.replayWrites === undefined ? settings.replayWrites : Boolean(next.replayWrites),
    };
    mkdirSync(dir, { recursive: true });
    ensureIgnore(root);
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }

  function spentToday() {
    const day = new Date().toISOString().slice(0, 10);
    return readLines(usageFile)
      .filter((u) => u.at.startsWith(day))
      .reduce((n, u) => n + (u.usd || 0), 0);
  }

  /** Throws before a paid call that would go over today's budget. */
  function guardBudget(routeInfo) {
    if (routeInfo.kind !== 'anthropic') return;
    const left = settings.dailyBudgetUsd - spentToday();
    if (routeInfo.estimateUsd > left) {
      throw new Error(`This would go over today's AI budget ($${settings.dailyBudgetUsd.toFixed(2)}, $${Math.max(0, left).toFixed(2)} left). Raise it in AI settings, or use the local model.`);
    }
  }

  function recordUsage(task, routeInfo, costUsd) {
    if (costUsd) append(usageFile, { at: new Date().toISOString(), task, model: routeInfo.model, usd: costUsd });
  }

  return {
    get: () => settings,
    resolved,
    save,
    spentToday,
    guardBudget,
    recordUsage,
    history: () => readLines(historyFile),
    appendHistory: (row) => append(historyFile, row),
  };
}
