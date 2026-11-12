import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLANS = { claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise' };

/**
 * How this machine's Claude Code is paid for, from its own config: a Claude plan (flat fee, with 5-hour and
 * weekly limits) or per token. Only the plan fields are read.
 */
export function planOf(file = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json')) {
  let account;
  try {
    account = JSON.parse(readFileSync(file, 'utf8')).oauthAccount;
  } catch {
    return { kind: 'unknown' };
  }
  if (!account) return { kind: 'api' };
  const name = PLANS[account.organizationType];
  if (!name) return { kind: 'unknown' };
  return { kind: 'plan', name, extraUsage: Boolean(account.hasExtraUsageEnabled) };
}
