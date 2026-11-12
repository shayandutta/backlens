/**
 * Picks who does a job (template, local model, or a Claude model and effort level) from facts
 * backlens already has about the issue, before any AI runs. Every decision carries its reasons.
 */

export const CLAUDE = {
  haiku: { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', in: 0.1, out: 0.5, cacheRead: 0.01 },
  sonnet: { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', in: 2, out: 10, cacheRead: 0.2 },
  opus: { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', in: 4, out: 20, cacheRead: 0.2 },
};
const TIERS = ['haiku', 'sonnet', 'opus'];

// Expected output, including the model's own reasoning, per kind of job. Measured numbers replace these later.
const EXPECTED_OUT = { explain: 1500, fix: 5000 };

export function costUsd(tier, usage) {
  const p = CLAUDE[tier];
  const input = (usage.input_tokens || 0) * p.in + (usage.cache_creation_input_tokens || 0) * p.in * 1.25 + (usage.cache_read_input_tokens || 0) * p.cacheRead;
  return (input + (usage.output_tokens || 0) * p.out) / 1e6;
}

export function estimateUsd(tier, task, inputTokens) {
  const p = CLAUDE[tier];
  return (inputTokens * p.in + EXPECTED_OUT[task] * p.out) / 1e6;
}

/** How hard a fix looks, from what backlens measured. */
export function difficulty(issue, ctx, hasTests) {
  const reasons = [];
  let score = 0;
  const files = new Set(issue.sites.map((s) => s.replace(/:\d+$/, '')));
  if (files.size > 1) {
    score += 2;
    reasons.push('the two code paths are in different files');
  } else reasons.push('everything is in one file');
  if (issue.type === 'n-plus-one') {
    score += 1;
    reasons.push('an N+1 usually needs a batched query');
  }
  if (issue.type === 'repeat' && /\d+ calls are made twice/.test(issue.title)) {
    score += 1;
    reasons.push('several calls repeat together');
  }
  if (ctx.tokens > 15000) {
    score += 1;
    reasons.push('a lot of code to read');
  }
  if (!hasTests) {
    score += 1;
    reasons.push('no tests to catch a wrong fix');
  } else reasons.push('tests can check the fix');
  return { score, reasons };
}

/** Pass rate of past fixes for this kind of issue on one tier, from local history. */
function passRate(history, type, tier) {
  const runs = history.filter((h) => h.type === type && h.tier === tier && h.verified !== undefined);
  if (runs.length < 5) return null;
  return runs.filter((h) => h.verified).length / runs.length;
}

/**
 * task: 'explain' | 'fix'. attempt: 0 first try, 1 after a failed check (one step up, never more).
 */
export function route({ task, issue, ctx, settings, history = [], attempt = 0, hasTests, noTemplate = false }) {
  if (task === 'fix' && issue.type === 'serial' && !noTemplate) {
    return { kind: 'template', template: 'promise-all', label: 'backlens, no AI', reasons: ['calls that only read and do not use each other\'s results can be rewritten with Promise.all exactly, without a model'], estimateUsd: 0 };
  }
  if (task === 'fix' && issue.type === 'index') {
    return { kind: 'template', label: 'template, no AI', reasons: ['an index is the same fix every time, so backlens writes it itself'], estimateUsd: 0 };
  }
  if (settings.provider === 'mock') {
    return { kind: 'mock', label: 'mock (recorded answers)', reasons: ['mock provider is selected: nothing is sent anywhere'], estimateUsd: 0 };
  }
  if (settings.provider === 'ollama') {
    return { kind: 'ollama', model: settings.ollamaModel, label: `${settings.ollamaModel} on this machine`, reasons: ['local model is selected: free, and the code never leaves this machine'], estimateUsd: 0 };
  }
  // Claude, with the user's own key.
  if (task === 'explain') {
    const tier = 'haiku';
    return { kind: 'anthropic', tier, model: CLAUDE[tier].id, effort: 'low', label: `${CLAUDE[tier].name}, low effort`, reasons: ['explaining needs no heavy reasoning'], estimateUsd: estimateUsd(tier, task, ctx.tokens) };
  }
  const { score, reasons } = difficulty(issue, ctx, hasTests);
  let tier = score >= 3 ? 'opus' : 'sonnet';
  let effort = score >= 3 ? 'medium' : score >= 1 ? 'medium' : 'low';
  const rate = passRate(history, issue.type, tier);
  if (rate !== null && rate < 0.6 && tier !== 'opus') {
    tier = TIERS[TIERS.indexOf(tier) + 1];
    reasons.push(`past fixes of this kind passed ${Math.round(rate * 100)}% of the time on the smaller model`);
  }
  if (attempt > 0) {
    if (tier !== 'opus') tier = TIERS[TIERS.indexOf(tier) + 1];
    effort = 'high';
    reasons.push('the previous fix failed its check, so one step up');
  }
  return { kind: 'anthropic', tier, model: CLAUDE[tier].id, effort, label: `${CLAUDE[tier].name}, ${effort} effort`, reasons, estimateUsd: estimateUsd(tier, task, ctx.tokens) };
}
