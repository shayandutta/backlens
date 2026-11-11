import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { limitUsed, readLimits } from '../statusline/statusline.js';
import { planOf } from './plan.js';
import { sourceTokens } from './source.js';
import { isBacklens, readSession, toolShort, transcriptDirs } from './transcripts.js';

/**
 * Prompts in the last `days` in which an agent called a backlens tool, newest first, with totals per session
 * and an estimate of what the same work needs without backlens.
 */
export async function agentUsage({ root, days = 30, projects, plan = planOf(), limits = readLimits() } = {}) {
  const since = Date.now() - days * 864e5;
  const files = [];
  for (const dir of transcriptDirs(root, projects)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      if (statSync(file).mtimeMs >= since) files.push(file);
    }
  }
  const turns = [];
  for (const file of files) for (const t of await readSession(file)) if (Date.parse(t.start) >= since && Object.keys(t.tools).some(isBacklens)) turns.push(t);
  turns.sort((a, b) => (a.start < b.start ? 1 : -1));

  const source = sourceTokens(root);
  const view = turns.map((t) => {
    const backlens = Object.entries(t.tools).filter(([n]) => isBacklens(n));
    const other = Object.entries(t.tools).filter(([n]) => !isBacklens(n));
    const findings = Math.round(t.backlensChars / 4);
    return {
      session: t.session,
      start: t.start,
      seconds: Math.round((Date.parse(t.end) - Date.parse(t.start)) / 1000),
      models: Object.keys(t.models),
      tokens: { ...t.tokens, total: t.tokens.input + t.tokens.cacheWrite + t.tokens.cacheRead + t.tokens.output },
      usd: t.unpriced && !t.usd ? null : Math.round(t.usd * 10000) / 10000,
      backlensCalls: backlens.reduce((n, [, c]) => n + c, 0),
      backlensTools: Object.fromEntries(backlens.map(([n, c]) => [toolShort(n), c])),
      fileReads: (t.tools.Read || 0) + (t.tools.Grep || 0) + (t.tools.Glob || 0),
      edits: (t.tools.Edit || 0) + (t.tools.Write || 0) + (t.tools.MultiEdit || 0),
      otherCalls: other.reduce((n, [, c]) => n + c, 0),
      findingsTokens: findings,
      // Percentage points of the Claude plan's limits this prompt used, when the status line recorded them.
      limits: { five: limitUsed(limits, Date.parse(t.start), Date.parse(t.end), 'five'), seven: limitUsed(limits, Date.parse(t.start), Date.parse(t.end), 'seven') },
    };
  });

  const sessions = new Map();
  for (const t of view) {
    const s = sessions.get(t.session) || { session: t.session, prompts: 0, usd: 0, tokens: 0, backlensCalls: 0, first: t.start, last: t.start, five: 0, fiveKnown: 0 };
    s.prompts++;
    if (t.limits.five !== null) {
      s.five += t.limits.five;
      s.fiveKnown++;
    }
    s.usd += t.usd || 0;
    s.tokens += t.tokens.total;
    s.backlensCalls += t.backlensCalls;
    if (t.start < s.first) s.first = t.start;
    if (t.start > s.last) s.last = t.start;
    sessions.set(t.session, s);
  }
  return { days, plan, recording: limits.length > 0, prompts: view, sessions: [...sessions.values()], source };
}
