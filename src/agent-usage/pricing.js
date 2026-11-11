/** Anthropic API list prices, and what one API response cost. */

// USD per million tokens: input, output, cache read. Cache writes are 1.25x input (5 minutes) or 2x (1 hour).
// Longest prefix wins. Unknown models get token counts but no cost.
const PRICES = [
  ['claude-fable-5', 10, 50, 0.25],
  ['claude-mythos-5', 10, 50, 0.25],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4', 5, 25, 0.5],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4', 1, 5, 0.1],
];

export function priceOf(model) {
  if (!model) return null;
  let best = null;
  for (const p of PRICES) if (model.startsWith(p[0]) && (!best || p[0].length > best[0].length)) best = p;
  return best && { in: best[1], out: best[2], cacheRead: best[3] };
}

/** Cost of one API response's `usage`, or null when the model's price is unknown. */
export function usageCost(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  const w1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
  const w5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  const usd = ((u.input_tokens || 0) * p.in + w5m * p.in * 1.25 + w1h * p.in * 2 + (u.cache_read_input_tokens || 0) * p.cacheRead + (u.output_tokens || 0) * p.out) / 1e6;
  return u.speed === 'fast' ? usd * 2 : usd;
}
