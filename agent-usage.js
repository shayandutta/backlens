/**
 * What AI agents spent while working with backlens, read from Claude Code's own session logs
 * (~/.claude/projects/<project>/<session>.jsonl). Only counts are read: token usage, model names,
 * tool names and the size of backlens's answers. Prompts, code and replies are never kept or returned.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';

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

const encode = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');

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
async function readSession(file) {
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
const toolShort = (name) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');

/** Tokens of the app's own source: what an agent reads when it has to find these issues in the code instead. */
export function sourceTokens(root, limit = 20000) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.backlens', 'test', 'tests', '__tests__', 'generated', 'migrations', 'drizzle', 'public', 'static']);
  const EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.mts', '.cts', '.prisma']);
  let chars = 0;
  let files = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files >= limit) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name));
      } else if (EXT.has(extname(e.name)) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(e.name) && !/(^|[\\/])(vitest|jest|eslint|prettier)\.config/.test(e.name)) {
        try {
          chars += statSync(join(dir, e.name)).size;
          files++;
        } catch {}
      }
    }
  };
  walk(root);
  return { tokens: Math.round(chars / 4), files };
}

/**
 * Prompts in the last `days` in which an agent called a backlens tool, newest first, with totals per session
 * and an estimate of what the same work needs without backlens.
 */
export async function agentUsage({ root, days = 30, projects } = {}) {
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
    };
  });

  const sessions = new Map();
  for (const t of view) {
    const s = sessions.get(t.session) || { session: t.session, prompts: 0, usd: 0, tokens: 0, backlensCalls: 0, first: t.start, last: t.start };
    s.prompts++;
    s.usd += t.usd || 0;
    s.tokens += t.tokens.total;
    s.backlensCalls += t.backlensCalls;
    if (t.start < s.first) s.first = t.start;
    if (t.start > s.last) s.last = t.start;
    sessions.set(t.session, s);
  }
  return { days, prompts: view, sessions: [...sessions.values()], source };
}

// ---- words --------------------------------------------------------------------------------

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

export function promptLine(t) {
  return `${usdText(t.usd)}, ${kTokens(t.tokens.total)} tokens (${kTokens(t.tokens.output)} written), ${t.seconds < 90 ? `${t.seconds} s` : `${Math.round(t.seconds / 60)} min`}, ${count(t.backlensCalls, 'backlens call')}, ${count(t.fileReads, 'file read')}, ${count(t.edits, 'edit')}`;
}

export function usageText(u, { current } = {}) {
  if (!u.prompts.length) return `No Claude Code prompts used backlens in this project in the last ${u.days} days. (Only Claude Code keeps the logs this reads; other editors are not counted.)`;
  const [last] = u.prompts;
  const session = u.sessions.find((s) => s.session === last.session);
  const all = u.prompts.reduce((n, t) => n + (t.usd || 0), 0);
  const out = [
    `${current ? 'This prompt so far' : 'Latest prompt'}: ${promptLine(last)}${last.models.length ? ` (${last.models.join(', ')})` : ''}.`,
    `This session: ${usdText(session.usd)} over ${count(session.prompts, 'prompt')} that used backlens.`,
    `Last ${u.days} days: ${usdText(all)} over ${count(u.prompts.length, 'prompt')}.`,
  ];
  const w = withoutBacklens(last, u.source);
  if (w)
    out.push(
      `Without backlens (estimate): finding these by reading the code means going through up to ${kTokens(w.sourceTokens)} tokens of source in ${count(w.sourceFiles, 'file')}; backlens handed over ${kTokens(w.findingsTokens)} (${Math.round(w.contextSaved * 100)}% less to read${w.minExtraUsd ? `, at least ${usdText(w.minExtraUsd)} more` : ''}), and reading code gives no query counts or timings to prove a fix.`,
    );
  out.push('Prices are Anthropic API list prices; on a Claude subscription this counts against plan limits instead.');
  return out.join('\n');
}

export const _test = { readSession, encode };
