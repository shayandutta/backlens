import { askAnthropic } from './anthropic.js';
import { mockAnswer } from './mock.js';
import { askOllama } from './ollama.js';
import { issuePrompt } from './prompts.js';

/**
 * Three ways to get an answer: recorded answers (mock), a model on this machine (ollama), or
 * Claude with the user's own key (anthropic). Conversations can run several turns, so backlens can
 * send back what went wrong (an edit that did not fit, a type error) and ask again.
 */

export { anthropicStatus, testKey } from './anthropic.js';
export { LOCAL_MODELS, ollamaStatus, recommendedModel, startPull, stopPull } from './ollama.js';
export { EXPLAIN_SCHEMA, FIX_SCHEMA, issuePrompt, parseAnswer, SYSTEM } from './prompts.js';

/**
 * messages: the conversation so far (user turns and the model's earlier answers). The first user
 * turn is built from the issue when messages is empty.
 */
export async function ask({ task, issue, ctx, routeInfo, root, previous, messages = [], onProgress, signal }) {
  if (routeInfo.kind === 'mock') return mockAnswer(task, issue, root);
  const convo = messages.length ? messages : [{ role: 'user', content: issuePrompt(task, issue, ctx, previous) }];
  if (routeInfo.kind === 'ollama') return askOllama(task, convo, routeInfo.model, onProgress, signal);
  if (routeInfo.kind === 'anthropic') return askAnthropic(task, convo, routeInfo);
  throw new Error(`No provider for ${routeInfo.kind}`);
}
