import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { usageCost } from './pricing.js';

/**
 * Claude Code's own session logs (~/.claude/projects/<project>/<session>.jsonl), read into one turn
 * per prompt. Only counts are read: token usage, model names, tool names and the size of
 * backlens's answers. Prompts, code and replies are never kept or returned.
 */

export const encode = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');

/** Claude Code's folders for this project, the folders above it (a session opened at the repo root) and below it. */
export function transcriptDirs(root, projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')) {
  if (!existsSync(projects)) return [];
  const names = new Set();
  const home = homedir();
  for (let dir = root; dir && dir !== dirname(dir) && dir !== home; dir = dirname(dir)) names.add(encode(dir));
  const own = encode(root);
  const out = [];
  for (const name of readdirSync(projects)) if (names.has(name) || name.startsWith(own + '-')) out.push(join(projects, name));
  return out;
}

const isPrompt = (l) =>
  l.type === 'user' &&
  !l.isMeta &&
  !l.isSidechain &&
  l.message &&
  (typeof l.message.content === 'string' || (Array.isArray(l.message.content) && l.message.content.some((c) => c.type === 'text')));

const resultChars = (c) => (typeof c.content === 'string' ? c.content.length : Array.isArray(c.content) ? c.content.reduce((n, x) => n + (x.text ? x.text.length : 0), 0) : 0);

const emptyTokens = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

function addUsage(turn, model, u) {
  turn.tokens.input += u.input_tokens || 0;
  turn.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
  turn.tokens.cacheRead += u.cache_read_input_tokens || 0;
  turn.tokens.output += u.output_tokens || 0;
  turn.calls++;
  if (model) turn.models[model] = (turn.models[model] || 0) + 1;
  const usd = usageCost(model, u);
  if (usd === null) turn.unpriced = true;
  else turn.usd += usd;
}

const cache = new Map();

/** Reads one session log into turns: one per prompt, with what it cost and which tools it used. */
export async function readSession(file) {
  const st = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.turns;
  const turns = [];
  let turn = null;
  const seen = new Set();
  const toolName = new Map();
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    let l;
    try {
      l = JSON.parse(line);
    } catch {
      continue;
    }
    if (isPrompt(l)) {
      turn = { session: l.sessionId, start: l.timestamp, end: l.timestamp, tokens: emptyTokens(), usd: 0, calls: 0, models: {}, tools: {}, backlensChars: 0, unpriced: false };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (l.timestamp) turn.end = l.timestamp;
    const content = l.message && Array.isArray(l.message.content) ? l.message.content : [];
    if (l.type === 'assistant') {
      for (const c of content) {
        if (c.type !== 'tool_use') continue;
        turn.tools[c.name] = (turn.tools[c.name] || 0) + 1;
        toolName.set(c.id, c.name);
      }
      const m = l.message;
      if (m.usage && m.id && !seen.has(m.id) && m.model !== '<synthetic>') {
        seen.add(m.id);
        addUsage(turn, m.model, m.usage);
      }
    } else {
      for (const c of content) if (c.type === 'tool_result' && isBacklens(toolName.get(c.tool_use_id))) turn.backlensChars += resultChars(c);
    }
  }
  // Subagents write their own logs next to the session; their cost belongs to the prompt that started them.
  const subDir = join(dirname(file), file.slice(dirname(file).length + 1, -'.jsonl'.length), 'subagents');
  if (existsSync(subDir)) {
    for (const name of readdirSync(subDir).filter((n) => n.endsWith('.jsonl'))) {
      const seenSub = new Set();
      for (const line of readFileSync(join(subDir, name), 'utf8').split('\n')) {
        if (!line.includes('"assistant"')) continue;
        let l;
        try {
          l = JSON.parse(line);
        } catch {
          continue;
        }
        const m = l.message;
        if (!m || !m.usage || seenSub.has(m.id)) continue;
        seenSub.add(m.id);
        const owner = turns.findLast((t) => t.start <= l.timestamp);
        if (!owner) continue;
        addUsage(owner, m.model, m.usage);
        for (const c of m.content || []) if (c.type === 'tool_use') owner.tools[c.name] = (owner.tools[c.name] || 0) + 1;
      }
    }
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, turns });
  return turns;
}

export const isBacklens = (name) => Boolean(name) && /^mcp__backlens(_[a-z0-9-]+)?__/i.test(name);
export const toolShort = (name) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
