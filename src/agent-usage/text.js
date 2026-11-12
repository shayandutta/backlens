import { priceOf } from './pricing.js';

/** The words: what a prompt cost, for the Agents tab and the MCP `usage` tool. */

export const usdText = (n) => (n === null || n === undefined ? 'cost unknown' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** What finding the same issues by reading code would take, from this prompt's numbers. Null when there is nothing to compare. */
export function withoutBacklens(prompt, source) {
  if (!prompt.findingsTokens || !source.tokens || source.tokens <= prompt.findingsTokens) return null;
  const model = prompt.models[0];
  const p = priceOf(model);
  const extra = source.tokens - prompt.findingsTokens;
  // Lower bound: the extra code is read once and cached; every later step rereads it too, so the real cost is higher.
  const minUsd = p ? (extra * p.in * 1.25) / 1e6 : null;
  return { sourceTokens: source.tokens, sourceFiles: source.files, findingsTokens: prompt.findingsTokens, contextSaved: 1 - prompt.findingsTokens / source.tokens, minExtraUsd: minUsd };
}

const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;


const pct = (n) => (n < 1 ? 'under 1%' : `${Math.round(n)}%`);

/** What a prompt really cost the user: plan limits on a Claude plan, dollars when paying per token. */
export function costLine(t, plan) {
  if (plan.kind !== 'plan') return usdText(t.usd);
  if (t.limits.five === null) return `${plan.name} plan, limit use not recorded`;
  return `${pct(t.limits.five)} of your 5-hour limit${t.limits.seven !== null ? `, ${pct(t.limits.seven)} of the week` : ''}`;
}

export function usageText(u, { current } = {}) {
  if (!u.prompts.length) return `No Claude Code prompts used backlens in this project in the last ${u.days} days. (Only Claude Code keeps the logs this reads; other editors are not counted.)`;
  const [last] = u.prompts;
  const session = u.sessions.find((s) => s.session === last.session);
  const all = u.prompts.reduce((n, t) => n + (t.usd || 0), 0);
  const onPlan = u.plan.kind === 'plan';
  const work = `${kTokens(last.tokens.total)} tokens (${kTokens(last.tokens.output)} written), ${last.seconds < 90 ? `${last.seconds} s` : `${Math.round(last.seconds / 60)} min`}, ${count(last.backlensCalls, 'backlens call')}, ${count(last.fileReads, 'file read')}, ${count(last.edits, 'edit')}`;
  const out = [`${current ? 'This prompt so far' : 'Latest prompt'}: ${costLine(last, u.plan)}; ${work}${last.models.length ? ` (${last.models.join(', ')})` : ''}.`];
  if (onPlan) {
    out.push(
      `Billing: Claude ${u.plan.name} plan, a flat fee${u.plan.extraUsage ? ' (extra usage is on: past the limits it is billed)' : ', nothing billed per prompt'}. At API prices this prompt would be ${usdText(last.usd)}.`,
    );
    if (session.fiveKnown) out.push(`This session: ${pct(session.five)} of the 5-hour limit over ${count(session.fiveKnown, 'prompt')} that used backlens.`);
    if (!u.recording) out.push('Plan limits are not being recorded: run `backlens statusline --install` once to see what each prompt uses.');
  } else {
    out.push(`This session: ${usdText(session.usd)} over ${count(session.prompts, 'prompt')} that used backlens.`, `Last ${u.days} days: ${usdText(all)} over ${count(u.prompts.length, 'prompt')}.`);
  }
  const w = withoutBacklens(last, u.source);
  if (w)
    out.push(
      `Without backlens (estimate): finding these by reading the code means going through up to ${kTokens(w.sourceTokens)} tokens of source in ${count(w.sourceFiles, 'file')}; backlens handed over ${kTokens(w.findingsTokens)} (${Math.round(w.contextSaved * 100)}% less to read), and reading code gives no query counts or timings to prove a fix.`,
    );
  if (!onPlan) out.push(u.plan.kind === 'api' ? 'Costs at Anthropic API list prices, which is what per-token billing charges.' : 'Costs at Anthropic API list prices; on a Claude plan they count against its limits instead.');
  return out.join('\n');
}
