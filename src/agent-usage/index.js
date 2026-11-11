/**
 * What AI agents spent while working with backlens, read from Claude Code's own session logs. Only
 * counts are read: token usage, model names, tool names and the size of backlens's answers.
 * Prompts, code and replies are never kept or returned.
 */
export { planOf } from './plan.js';
export { priceOf, usageCost } from './pricing.js';
export { sourceTokens } from './source.js';
export { costLine, kTokens, usageText, usdText, withoutBacklens } from './text.js';
export { isBacklens, transcriptDirs } from './transcripts.js';
export { agentUsage } from './usage.js';

import { encode, readSession } from './transcripts.js';
export const _test = { readSession, encode };
