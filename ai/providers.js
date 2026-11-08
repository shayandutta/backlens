import { existsSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import { currentKey, lastFour } from './credentials.js';
import { costUsd } from './router.js';

/**
 * Three ways to get an answer: recorded answers (mock), a model on this machine (ollama), or
 * Claude with the user's own key (anthropic). Conversations can run several turns, so backlens can
 * send back what went wrong (an edit that did not fit, a type error) and ask again.
 */

export const SYSTEM = `You are backlens's fix assistant. backlens watched a Node.js backend serve real requests and found a performance issue: a query or Redis call repeated within one request, an N+1 query loop, or calls awaited one after another.

You get the issue, the statements involved, and the code around every place in the app that made the calls. Every code line is shown with its line number, like "   74  const x = 1;". Line numbers are for reference and never part of the code.

Answer in exactly this format and nothing else:

EXPLANATION:
What the change does and why it removes the issue, or why no change is safe.

CONFIDENCE: high

EDIT src/path/to/file.ts 74-79
\`\`\`
the complete new code for lines 74 to 79, without line numbers, indented like the code around it
\`\`\`

NOTES:
Risks or assumptions, or why there are no edits.

Rules for edits:
- An EDIT replaces whole lines, from the first to the last number given (inclusive), using the numbers shown. The code block is everything that goes there instead; it can have more or fewer lines. An empty code block deletes the lines.
- Write as many EDIT blocks as needed, or none if no change is safe. CONFIDENCE is high, medium or low.
- Only edit lines you were shown, in files you were shown. Edits must not overlap.
- Change as little as possible. Keep the code's style, names and types. Do not change behaviour: same results, same errors, same order of side effects. Only remove repeated work or run independent work together.
- For calls that wait for each other: first check whether any call uses a result of an earlier one (an id, a row, a value). If any does, they cannot run together: return no edits and say which call depends on which.
- If the issue is not real here, or a safe fix needs code you were not shown, return no edits and say why in notes.
- confidence is how sure you are that the edits compile and remove the issue.
- Write explanations in plain words a busy developer reads in ten seconds.`;

export const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what is happening.' },
    why_it_matters: { type: 'string', description: 'What it costs: time, load, as the app grows.' },
    how_to_fix: { type: 'string', description: 'The fix in words, naming the functions to change.' },
  },
  required: ['summary', 'why_it_matters', 'how_to_fix'],
  additionalProperties: false,
};

/** Reads the plain-text answer format; returns null if the text does not follow it. */
export function parseAnswer(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const section = (name) => {
    const m = t.match(new RegExp(`(?:^|\\n)${name}:[ \\t]*\\n?([\\s\\S]*?)(?=\\n(?:EXPLANATION:|CONFIDENCE:|EDIT |NOTES:)|$)`));
    return m ? m[1].trim() : '';
  };
  const explanation = section('EXPLANATION');
  const confidence = (t.match(/CONFIDENCE:\s*(high|medium|low)/i) || [])[1];
  const edits = [];
  const re = /(?:^|\n)EDIT[ \t]+(\S+)[ \t]+(\d+)\s*-\s*(\d+)[^\n]*\n```[^\n]*\n([\s\S]*?)\n?```/g;
  let m;
  while ((m = re.exec(t))) edits.push({ file: m[1], from_line: Number(m[2]), to_line: Number(m[3]), new_code: m[4] });
  if (!explanation && !edits.length) return null;
  return { explanation, confidence: confidence ? confidence.toLowerCase() : 'low', edits, notes: section('NOTES') };
}

export const FIX_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: 'What the change does and why it removes the issue, or why no change is safe.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          from_line: { type: 'integer' },
          to_line: { type: 'integer' },
          new_code: { type: 'string' },
        },
        required: ['file', 'from_line', 'to_line', 'new_code'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string', description: 'Risks, assumptions, or why no edits were made.' },
  },
  required: ['explanation', 'confidence', 'edits', 'notes'],
  additionalProperties: false,
};

export function issuePrompt(task, issue, ctx, previous) {
  const parts = [
    `Issue: ${issue.title}`,
    `Route: ${issue.route}`,
    `Seen in ${issue.seen} of ${issue.of} requests, about ${issue.cost} ms lost each time.`,
    `Where the code paths part: ${issue.sites.join(' and ')}`,
    `Statements involved:\n${issue.sql}`,
    `backlens's suggested direction: ${issue.fix}`,
    ...ctx.files.map((f) => `--- ${f.path} (lines ${f.from}-${f.to})\n${f.text}`),
  ];
  if (previous) parts.push(`A previous attempt was applied and failed its check: ${previous.reason}\nTry a different approach.`);
  parts.push(task === 'explain' ? 'Explain this issue.' : 'Propose the smallest safe fix, in the answer format.');
  return parts.join('\n\n');
}

// ---- mock -----------------------------------------------------------------------------
function mock(task, issue, root) {
  if (task === 'explain') {
    return {
      data: {
        summary: `${issue.title} on ${issue.route}.`,
        why_it_matters: `Each time, about ${issue.cost} ms goes to work the request already did, in ${issue.seen} of ${issue.of} requests seen.`,
        how_to_fix: issue.fix,
      },
      costUsd: 0,
    };
  }
  // Recorded fixes for tests and demos: .backlens/ai-fixtures.json, [{ match, response }].
  const file = join(root, '.backlens', 'ai-fixtures.json');
  if (existsSync(file)) {
    try {
      for (const f of JSON.parse(readFileSync(file, 'utf8'))) {
        if (`${issue.title} ${issue.sites.join(' ')} ${issue.sql}`.includes(f.match)) return { data: f.response, costUsd: 0 };
      }
    } catch {}
  }
  return { data: { explanation: 'The mock provider has no recorded fix for this issue.', confidence: 'low', edits: [], notes: 'Pick the local model or Claude in AI settings for a real suggestion.' }, costUsd: 0 };
}

// ---- ollama ---------------------------------------------------------------------------
export const OLLAMA = 'http://127.0.0.1:11434';

/** Coding models in sizes for 8, 16 and 32 GB of memory; download sizes as Ollama lists them. */
export const LOCAL_MODELS = [
  { name: 'qwen2.5-coder:3b', sizeGb: 1.9, minRamGb: 0, note: 'fits 8 GB. Explains well; fixes are hit-and-miss.' },
  { name: 'qwen2.5-coder:7b', sizeGb: 4.7, minRamGb: 14, note: 'needs 16 GB. Better fixes, still check them.' },
  { name: 'qwen2.5-coder:14b', sizeGb: 9.0, minRamGb: 28, note: 'needs 32 GB. The best of the three.' },
];

/** The biggest model this machine's memory can hold alongside the app and an editor. */
export function recommendedModel(ramGb = totalmem() / 1024 ** 3) {
  return [...LOCAL_MODELS].reverse().find((m) => ramGb >= m.minRamGb) || LOCAL_MODELS[0];
}

/** Whether the Ollama app or command is on this machine, even when it is not running. */
function ollamaInstalled() {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const places = [
    ...(process.env.PATH || '').split(delimiter).map((d) => join(d, exe)),
    '/Applications/Ollama.app',
    join(process.env.HOME || '', 'Applications', 'Ollama.app'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
  ];
  return places.some((p) => p && existsSync(p));
}

export async function ollamaStatus() {
  const ramGb = Math.round(totalmem() / 1024 ** 3);
  const base = { ramGb, recommended: recommendedModel(ramGb).name, catalog: LOCAL_MODELS, pull: pullState };
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return { ...base, installed: true, running: true, models: (body.models || []).map((m) => m.name) };
  } catch {
    return { ...base, installed: ollamaInstalled(), running: false, models: [] };
  }
}

// ---- downloading a model, started from the dashboard ------------------------------------
let pullState = null;
let pullAbort = null;

/** Starts downloading a model through Ollama's own API; progress is read from ollamaStatus().pull. */
export function startPull(model) {
  if (!/^[\w.-]{1,60}(:[\w.-]{1,40})?$/.test(model || '')) throw new Error('Not a model name.');
  if (pullState && !pullState.done) throw new Error(`Already downloading ${pullState.model}.`);
  pullAbort = new AbortController();
  pullState = { model, status: 'starting', completed: 0, total: 0, done: false, error: null };
  const state = pullState;
  (async () => {
    try {
      const res = await fetch(`${OLLAMA}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: pullAbort.signal,
      });
      if (!res.ok) throw new Error(`Ollama answered ${res.status}.`);
      const decoder = new TextDecoder();
      let buffer = '';
      // Ollama reports each layer separately; the big one is the model itself, so show the largest.
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const part = JSON.parse(line);
          if (part.error) throw new Error(part.error);
          state.status = part.status || state.status;
          if (part.total && part.total >= state.total) {
            state.total = part.total;
            state.completed = part.completed || 0;
          }
        }
      }
      state.done = true;
      state.status = 'success';
    } catch (err) {
      state.done = true;
      state.error = err.name === 'AbortError' ? 'Download stopped.' : `Download failed: ${err.message}`;
    }
  })();
  return state;
}

export function stopPull() {
  if (pullAbort) pullAbort.abort();
}

/** Streams the answer, reporting tokens as they arrive, then parses the finished JSON. */
async function ollama(task, messages, model, onProgress, signal) {
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        // Explanations come back as JSON; fixes as plain text, because code inside JSON is where small models stumble.
        ...(task === 'explain' ? { format: EXPLAIN_SCHEMA } : {}),
        // 8k context and a cap on the answer keep a small model fast on a laptop with little memory.
        options: { temperature: 0, num_ctx: 8192, num_predict: 4096 },
        keep_alive: '15m',
        messages: [{ role: 'system', content: SYSTEM }, ...messages],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) : AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch (err) {
    if (signal && signal.aborted) throw new Error('Stopped.');
    throw new Error('Ollama is not running. Open the Ollama app, then try again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (/not found/i.test(body.error || '')) throw new Error(`The local model ${model} is not downloaded yet. Download it in AI settings.`);
    throw new Error(body.error ? `Ollama: ${body.error}` : `Ollama answered ${res.status}.`);
  }
  let text = '';
  let tokens = 0;
  let usage = {};
  const decoder = new TextDecoder();
  let buffer = '';
  try {
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let part;
      try {
        part = JSON.parse(line);
      } catch {
        continue;
      }
      if (part.error) throw new Error(`Ollama: ${part.error}`);
      if (part.message && part.message.content) {
        text += part.message.content;
        tokens++;
        if (onProgress) onProgress({ tokens, text });
      }
      if (part.done) {
        usage = { input_tokens: part.prompt_eval_count, output_tokens: part.eval_count };
        if (part.done_reason === 'length') throw new Error('The local model wrote too much and was cut off before finishing. Try again, or use a bigger model.');
      }
    }
  }
  } catch (err) {
    if (signal && signal.aborted) throw new Error('Stopped.');
    throw err;
  }
  const data = task === 'explain' ? safeJson(text) : parseAnswer(text);
  if (!data) throw Object.assign(new Error('The local model did not answer in the expected format.'), { raw: text });
  return { data, raw: text, usage, costUsd: 0 };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- anthropic (the user's own key) -------------------------------------------------------
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

async function anthropic(task, messages, routeInfo) {
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
    if (err instanceof Anthropic.APIError) throw new Error(`Claude error ${err.status}: ${err.message}`);
    throw err;
  }
  const cost = costUsd(routeInfo.tier, response.usage);
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request.'), { costUsd: cost });
  if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('The answer was cut off. Try again.'), { costUsd: cost });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const data = task === 'explain' ? safeJson(text) : parseAnswer(text);
  if (!data) throw Object.assign(new Error('Claude did not answer in the expected format.'), { costUsd: cost, raw: text });
  return { data, raw: text, usage: response.usage, costUsd: cost, servedBy: response.model };
}

/**
 * messages: the conversation so far (user turns and the model's earlier JSON answers). The first
 * user turn is built from the issue when messages is empty.
 */
export async function ask({ task, issue, ctx, routeInfo, root, previous, messages = [], onProgress, signal }) {
  if (routeInfo.kind === 'mock') return mock(task, issue, root);
  const convo = messages.length ? messages : [{ role: 'user', content: issuePrompt(task, issue, ctx, previous) }];
  if (routeInfo.kind === 'ollama') return ollama(task, convo, routeInfo.model, onProgress, signal);
  if (routeInfo.kind === 'anthropic') return anthropic(task, convo, routeInfo);
  throw new Error(`No provider for ${routeInfo.kind}`);
}
