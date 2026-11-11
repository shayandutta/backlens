import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import { EXPLAIN_SCHEMA, parseFor, SYSTEM } from './prompts.js';

/** A model on this machine through Ollama: free, and the code never leaves the machine. */

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

// ---- downloading a model, started from the dashboard ------------------------------------
let pullState = null;
let pullAbort = null;

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

const TEN_MINUTES = 10 * 60 * 1000;

/** Streams the answer, reporting tokens as they arrive, then parses it. */
export async function askOllama(task, messages, model, onProgress, signal) {
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
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TEN_MINUTES)]) : AbortSignal.timeout(TEN_MINUTES),
    });
  } catch {
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
  const data = parseFor(task, text);
  if (!data) throw Object.assign(new Error('The local model did not answer in the expected format.'), { raw: text });
  return { data, raw: text, usage, costUsd: 0 };
}
