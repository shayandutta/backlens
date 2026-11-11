import { currentKey, lastFour } from '../credentials.js';
import { costUsd } from '../router.js';
import { EXPLAIN_SCHEMA, parseFor, SYSTEM } from './prompts.js';

/** Claude with the user's own key. */

// A client per key, so pasting or removing a key in the dashboard takes effect at once.
let sdk = null;
async function client(key = currentKey().key) {
  if (!sdk || sdk.key !== key) {
    let mod;
    try {
      mod = await import('@anthropic-ai/sdk');
    } catch (err) {
      throw new Error(`Could not load the Claude client: ${err.message}.`);
    }
    try {
      sdk = { key, Anthropic: mod.default, client: new mod.default(key ? { apiKey: key } : {}) };
    } catch {
      throw new Error('No Claude API key. Paste one in AI settings.');
    }
  }
  return sdk;
}

/** Where the key comes from. The key itself is never returned, only its last four characters. */
export function anthropicStatus() {
  const { key, source } = currentKey();
  if (key) return { configured: true, source, last4: lastFour(key) };
  if (process.env.ANTHROPIC_AUTH_TOKEN) return { configured: true, source: 'token', last4: '' };
  return { configured: false, source: null, last4: '' };
}

/** Checks a key by listing models, which costs nothing. Returns null when it works, else the reason. */
export async function testKey(key) {
  const { Anthropic, client: c } = await client(key);
  try {
    await c.models.list({ limit: 1 });
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected this key.';
    if (err instanceof Anthropic.PermissionDeniedError) return 'This key is not allowed to use the API.';
    if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your connection.';
    if (err instanceof Anthropic.APIError) return `Claude error ${err.status}: ${err.message}`;
    return err.message;
  }
}

export async function askAnthropic(task, messages, routeInfo) {
  const { Anthropic, client: c } = await client();
  const params = {
    model: routeInfo.model,
    max_tokens: 16000,
    // The instructions never change, so they are cached; repeated fixes pay about a tenth for them.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: task === 'explain' ? { effort: routeInfo.effort, format: { type: 'json_schema', schema: EXPLAIN_SCHEMA } } : { effort: routeInfo.effort },
  };
  let response;
  try {
    // Opus and Sonnet: if a safety check declines, the API retries on a fallback model in the same call.
    response =
      routeInfo.tier === 'haiku'
        ? await c.messages.create(params)
        : await c.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the key. Paste a new one in AI settings.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit reached. Wait a minute and try again.');
    // The SDK's message carries the raw JSON body; show the API's own sentence instead.
    const said = err?.error?.error?.message || err.message;
    if (err instanceof Anthropic.APIError && /credit balance/i.test(said)) {
      throw Object.assign(new Error('Your Anthropic account has no credit left, so nothing was sent or charged. Add credits in the Anthropic Console, then try again.'), { code: 'billing' });
    }
    if (err instanceof Anthropic.APIError) throw new Error(`Claude error ${err.status}: ${said}`);
    throw err;
  }
  const cost = costUsd(routeInfo.tier, response.usage);
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request.'), { costUsd: cost });
  if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('The answer was cut off. Try again.'), { costUsd: cost });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const data = parseFor(task, text);
  if (!data) throw Object.assign(new Error('Claude did not answer in the expected format.'), { costUsd: cost, raw: text });
  return { data, raw: text, usage: response.usage, costUsd: cost, servedBy: response.model };
}
