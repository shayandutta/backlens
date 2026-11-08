import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, relative } from 'node:path';
import { checkTrace } from '../analyze.js';
import { ensureIgnore } from '../config.js';
import { buildContext, insideProject } from './context.js';
import { looksLikeKey, removeKey, saveKey } from './credentials.js';
import { anthropicStatus, ask, issuePrompt, LOCAL_MODELS, ollamaStatus, startPull, stopPull, testKey } from './providers.js';
import { route } from './router.js';
import { promiseAll } from './templates.js';

/**
 * Explain and Fix. A fix runs like a careful developer at a terminal, and every step is written to
 * a live feed the dashboard shows: read the code, ask the model, check each edit fits the code
 * (sending problems back, up to twice), apply (keeping an exact copy of each file as it was, uncommitted
 * changes included), typecheck (sending type errors back, up to twice), rebuild if needed, restart, replay
 * the request that showed the issue, run the tests. Only then is it called proven.
 */

// Replaying a write sends it again, so it changes the dev database twice: reads only unless asked.
// Replays after a fix: warm-up runs first, then measured runs (reads only).
const WARMUPS = 3;
const SAMPLES = 5;
const DEFAULTS = { provider: null, ollamaModel: null, dailyBudgetUsd: 1, replay: true, replayWrites: false };
const EDIT_REPAIRS = 2;
const TYPE_REPAIRS = 2;

/** The statements an issue is about, for telling whether it is still there after a fix. */
const statements = (issue) => new Set(String(issue.sql || '').split('\n').map((s) => s.trim()).filter(Boolean));
function sameIssue(a, b) {
  if (a.type !== b.type) return false;
  const sa = statements(a);
  for (const s of statements(b)) if (sa.has(s)) return true;
  return false;
}

/** new_code as models write it: fences, a copied line-number gutter, trailing spaces. */
export function cleanCode(code) {
  let lines = String(code ?? '').replace(/\r\n/g, '\n').split('\n');
  if (/^```/.test(lines[0] || '')) lines = lines.slice(1);
  if (/^```\s*$/.test(lines.at(-1) || '')) lines = lines.slice(0, -1);
  const filled = lines.filter((l) => l.trim());
  if (filled.length && filled.filter((l) => /^ {0,6}\d+ {1,2}/.test(l)).length / filled.length >= 0.6) lines = lines.map((l) => l.replace(/^ {0,6}\d+ {1,2}/, ''));
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n');
}

export function createAI(deps) {
  const { root } = deps;
  const dir = join(root, '.backlens');
  const settingsFile = join(dir, 'ai.json');
  const usageFile = join(dir, 'ai-usage.jsonl');
  const historyFile = join(dir, 'ai-history.jsonl');
  const jobs = new Map();
  const replayWaiters = new Map();

  const readLines = (file) => {
    try {
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const append = (file, row) => {
    mkdirSync(dir, { recursive: true });
    ensureIgnore(root);
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  };

  let settings = { ...DEFAULTS };
  try {
    settings = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsFile, 'utf8')) };
  } catch {}

  async function resolvedSettings() {
    const local = await ollamaStatus();
    // No model picked yet: one already downloaded if there is one, else the size this machine suits.
    const ollamaModel =
      settings.ollamaModel || LOCAL_MODELS.map((m) => m.name).find((n) => local.models.includes(n)) || local.models.find((n) => /coder/.test(n)) || local.recommended;
    // Nothing is ever paid by default: the local model if it is ready, recorded answers otherwise.
    const provider = settings.provider || (local.running && local.models.includes(ollamaModel) ? 'ollama' : 'mock');
    return { ...settings, ollamaModel, provider };
  }

  function spentToday() {
    const day = new Date().toISOString().slice(0, 10);
    return readLines(usageFile)
      .filter((u) => u.at.startsWith(day))
      .reduce((n, u) => n + (u.usd || 0), 0);
  }

  async function status() {
    const s = await resolvedSettings();
    return { settings: s, configured: Boolean(settings.provider), ollama: await ollamaStatus(), anthropic: anthropicStatus(), spentTodayUsd: spentToday(), history: readLines(historyFile).length };
  }

  function saveSettings(next) {
    settings = {
      provider: ['mock', 'ollama', 'anthropic'].includes(next.provider) ? next.provider : settings.provider,
      ollamaModel: typeof next.ollamaModel === 'string' && /^[\w.:/-]{1,80}$/.test(next.ollamaModel) ? next.ollamaModel : settings.ollamaModel,
      dailyBudgetUsd: Number.isFinite(Number(next.dailyBudgetUsd)) && Number(next.dailyBudgetUsd) >= 0 ? Number(next.dailyBudgetUsd) : settings.dailyBudgetUsd,
      replay: next.replay === undefined ? settings.replay : Boolean(next.replay),
      replayWrites: next.replayWrites === undefined ? settings.replayWrites : Boolean(next.replayWrites),
    };
    mkdirSync(dir, { recursive: true });
    ensureIgnore(root);
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }

  function guardBudget(routeInfo) {
    if (routeInfo.kind !== 'anthropic') return;
    const left = settings.dailyBudgetUsd - spentToday();
    if (routeInfo.estimateUsd > left) {
      throw new Error(`This would go over today's AI budget ($${settings.dailyBudgetUsd.toFixed(2)}, $${Math.max(0, left).toFixed(2)} left). Raise it in AI settings, or use the local model.`);
    }
  }

  function record(task, routeInfo, costUsd) {
    if (costUsd) append(usageFile, { at: new Date().toISOString(), task, model: routeInfo.model, usd: costUsd });
  }

  // ---- explain ---------------------------------------------------------------------------
  async function explain(issueKey) {
    const issue = deps.getIssue(issueKey);
    if (!issue) throw new Error('That issue is gone. Refresh the list.');
    const ctx = buildContext(root, issue);
    const s = await resolvedSettings();
    const routeInfo = route({ task: 'explain', issue, ctx, settings: s, hasTests: Boolean(deps.config()?.test) });
    guardBudget(routeInfo);
    const result = await ask({ task: 'explain', issue, ctx, routeInfo, root });
    record('explain', routeInfo, result.costUsd);
    return { ...result.data, by: routeInfo.label, costUsd: result.costUsd || 0 };
  }

  // ---- the live feed ---------------------------------------------------------------------
  function ev(job, kind, title, extra = {}) {
    const e = { at: Date.now() - job.at, kind, title, status: 'done', ...extra };
    job.events.push(e);
    return e;
  }

  const view = (job) => {
    const { ctx, issue, backups, convo, abort, afterTrace, written, ...rest } = job;
    return { ...rest, now: Date.now(), issueTitle: issue.title, issueRoute: issue.route, spentTodayUsd: spentToday(), budgetUsd: settings.dailyBudgetUsd };
  };

  async function startFix(issueKey, attempt = 0, previous = null) {
    const issue = deps.getIssue(issueKey);
    if (!issue) throw new Error('That issue is gone. Refresh the list.');
    const ctx = buildContext(root, issue);
    const s = await resolvedSettings();
    const routeInfo = route({ task: 'fix', issue, ctx, settings: s, history: readLines(historyFile), attempt, hasTests: Boolean(deps.config()?.test) });
    const job = { id: randomUUID(), issueKey, issue, ctx, attempt, previous, route: routeInfo, preview: ctx.preview, tokens: ctx.tokens, stage: 'preview', events: [], edits: [], diff: [], at: Date.now(), costUsd: 0, convo: [] };
    if (routeInfo.template === 'promise-all') {
      jobs.set(job.id, job);
      for (const f of ctx.files) ev(job, 'read', `Read ${f.path}`, { detail: `lines ${f.from}-${f.to}` });
      const t = promiseAll(root, issue);
      if (t.edits) {
        const { ok, rejected } = normalize(job, t.edits);
        if (ok.length && !rejected.length) {
          ev(job, 'say', t.explanation, { confidence: 'high' });
          for (const e of ok) ev(job, 'edit', `Update ${e.file}`, { diff: diffOf(e) });
          Object.assign(job, { stage: 'proposed', explanation: t.explanation, confidence: 'high', edits: ok, rejected: [], diff: ok.map(diffOf) });
          return view(job);
        }
      }
      // Not the simple shape: hand it to a model, with the reason.
      const reason = t.reason || 'the rewrite did not fit the code';
      job.route = route({ task: 'fix', issue, ctx, settings: s, history: readLines(historyFile), attempt, hasTests: Boolean(deps.config()?.test), noTemplate: true });
      job.route.reasons.unshift(`backlens could not rewrite this itself: ${reason}`);
      job.events = [];
      return view(job);
    }
    if (routeInfo.kind === 'template') {
      const sql = (issue.fix.match(/CREATE INDEX[^;]*;/) || [''])[0];
      Object.assign(job, { stage: 'template', explanation: `${issue.title}. Postgres reads every row to find matches. An index on those columns lets it jump straight to them.`, sql, notes: 'Run this in a migration. CONCURRENTLY builds the index without locking writes, and must run outside a transaction.' });
    }
    jobs.set(job.id, job);
    return view(job);
  }

  function getFix(id) {
    const job = jobs.get(id);
    return job ? view(job) : null;
  }

  // ---- edits -----------------------------------------------------------------------------
  /**
   * Turns the model's edits into exact line replacements, refusing any that touch lines it was not
   * shown, overlap, or change nothing. Recorded fixtures may use find/replace text instead.
   */
  function normalize(job, raw) {
    const shown = new Map();
    for (const f of job.ctx.files) shown.set(f.path, [...(shown.get(f.path) || []), { from: f.from, to: f.to }]);
    const ok = [];
    const rejected = [];
    for (const e of Array.isArray(raw) ? raw : []) {
      const abs = typeof e.file === 'string' ? insideProject(root, e.file) : null;
      const file = abs && relative(root, abs);
      if (!abs || !existsSync(abs) || !shown.has(file)) {
        rejected.push({ file: e.file, reason: `${e.file} is not one of the files you were shown (${[...shown.keys()].join(', ')})` });
        continue;
      }
      const lines = readFileSync(abs, 'utf8').split('\n');
      let from;
      let to;
      let replace;
      if (Number.isInteger(e.from_line) && Number.isInteger(e.to_line)) {
        from = e.from_line;
        to = e.to_line;
        replace = cleanCode(e.new_code);
        const ranges = shown.get(file);
        if (from < 1 || to < from || to > lines.length || !ranges.some((r) => from >= r.from && to <= r.to)) {
          // Small models often number later edits as if the earlier ones were already applied.
          const shift = ok
            .filter((o) => o.file === file && o.to < from)
            .reduce((n, o) => n + o.replace.split('\n').length - (o.to - o.from + 1), 0);
          const was = { from: from - shift, to: to - shift };
          const shifted = shift !== 0 && ranges.some((r) => was.from >= r.from && was.to <= r.to);
          rejected.push({
            file,
            from,
            to,
            reason: shifted
              ? `lines ${from}-${to} are numbered as if your earlier edit were already applied. Number every edit by the original lines shown: these look like lines ${was.from}-${was.to}`
              : `lines ${from}-${to} are outside what you were shown in ${file} (${ranges.map((r) => `${r.from}-${r.to}`).join(', ')})`,
          });
          continue;
        }
      } else if (typeof e.find === 'string' && e.find) {
        const content = lines.join('\n');
        const find = content.split(e.find).length === 2 ? e.find : null;
        if (!find) {
          rejected.push({ file, reason: 'the text to replace was not found exactly once' });
          continue;
        }
        // Widen to whole lines, keeping whatever sits before and after the text on its first and last line.
        const idx = content.indexOf(find);
        const lineStart = content.lastIndexOf('\n', idx - 1) + 1;
        const endIdx = idx + find.length;
        let lineEnd = content.indexOf('\n', endIdx);
        if (lineEnd === -1) lineEnd = content.length;
        from = content.slice(0, lineStart).split('\n').length;
        to = from + content.slice(lineStart, lineEnd).split('\n').length - 1;
        replace = content.slice(lineStart, idx) + String(e.replace ?? '') + content.slice(endIdx, lineEnd);
      } else {
        rejected.push({ file, reason: 'the edit has no line numbers' });
        continue;
      }
      const find = lines.slice(from - 1, to).join('\n');
      if (find === replace) {
        rejected.push({ file, from, to, reason: `the edit to lines ${from}-${to} changes nothing` });
        continue;
      }
      if (ok.some((o) => o.file === file && from <= o.to && to >= o.from)) {
        rejected.push({ file, from, to, reason: `lines ${from}-${to} overlap another edit` });
        continue;
      }
      ok.push({ file, from, to, find, replace });
    }
    return { ok, rejected };
  }

  function diffOf(e) {
    const lines = readFileSync(join(root, e.file), 'utf8').split('\n');
    let removed = e.find.split('\n');
    let added = e.replace === '' ? [] : e.replace.split('\n');
    let head = 0;
    while (head < removed.length - 1 && head < added.length - 1 && removed[head] === added[head]) head++;
    let tail = 0;
    while (tail < removed.length - head - 1 && tail < added.length - head - 1 && removed[removed.length - 1 - tail] === added[added.length - 1 - tail]) tail++;
    const start = e.from + head;
    const keptAfter = removed.slice(removed.length - tail);
    removed = removed.slice(head, removed.length - tail);
    added = added.slice(head, added.length - tail);
    return {
      file: e.file,
      line: start,
      before: lines.slice(Math.max(0, start - 4), start - 1).map((text, i) => ({ n: Math.max(1, start - 3) + i, text })),
      removed: removed.map((text, i) => ({ n: start + i, text })),
      added: added.map((text, i) => ({ n: start + i, text })),
      after: [...keptAfter, ...lines.slice(e.to, e.to + 3)].slice(0, 3).map((text, i) => ({ n: start + added.length + i, text })),
    };
  }

  function writeEdits(edits) {
    const byFile = new Map();
    for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) || []), e]);
    for (const [file, list] of byFile) {
      const abs = join(root, file);
      const lines = readFileSync(abs, 'utf8').split('\n');
      for (const e of [...list].sort((a, b) => b.from - a.from)) {
        if (lines.slice(e.from - 1, e.to).join('\n') !== e.find) throw new Error(`${file} changed since this suggestion. Ask for a new one.`);
        lines.splice(e.from - 1, e.to - e.from + 1, ...(e.replace === '' ? [] : e.replace.split('\n')));
      }
      writeFileSync(abs, lines.join('\n'));
    }
  }

  function readSafe(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  function restoreBackups(job) {
    for (const b of job.backups || []) copyFileSync(b.backup, join(root, b.file));
  }

  // ---- asking, with repairs ------------------------------------------------------------------
  async function askOnce(job, title) {
    guardBudget(job.route);
    const e = ev(job, 'ask', title, { status: 'running', tokens: 0, startedAt: Date.now() });
    const started = Date.now();
    job.abort = new AbortController();
    try {
      const result = await ask({
        task: 'fix',
        issue: job.issue,
        ctx: job.ctx,
        routeInfo: job.route,
        root,
        previous: job.previous,
        messages: job.convo,
        signal: job.abort.signal,
        onProgress: (p) => (e.tokens = p.tokens),
      });
      record('fix', job.route, result.costUsd);
      job.costUsd += result.costUsd || 0;
      e.status = 'done';
      e.detail = `${((Date.now() - started) / 1000).toFixed(1)} s${result.usage && result.usage.output_tokens ? `, ${result.usage.output_tokens} tokens` : ''}${result.costUsd ? `, $${result.costUsd.toFixed(4)}` : ''}`;
      if (job.route.kind !== 'mock') job.convo.push({ role: 'assistant', content: result.raw || JSON.stringify(result.data) });
      return result.data || {};
    } catch (err) {
      if (err.costUsd) {
        record('fix', job.route, err.costUsd);
        job.costUsd += err.costUsd;
      }
      e.status = 'fail';
      e.detail = err.message;
      if (err.raw !== undefined) {
        // Answered, but not in the format: show it the format again rather than giving up.
        job.convo.push({ role: 'assistant', content: err.raw || '(empty)' });
        return { formatError: true };
      }
      throw err;
    }
  }

  /** Ask, check every edit against the real code, and send problems back until the edits fit. */
  async function propose(job, firstTitle) {
    let title = firstTitle;
    for (let round = 0; round <= EDIT_REPAIRS; round++) {
      const answer = await askOnce(job, title);
      if (answer.formatError) {
        if (job.route.kind === 'mock' || round === EDIT_REPAIRS) throw new Error('The model did not answer in the expected format.');
        job.convo.push({ role: 'user', content: 'That did not follow the answer format. Answer again with EXPLANATION:, CONFIDENCE:, any EDIT blocks with a fenced code block each, and NOTES:.' });
        ev(job, 'repair', 'Asked the model to use the answer format');
        title = `Asking again (${round + 1} of ${EDIT_REPAIRS})`;
        continue;
      }
      ev(job, 'say', answer.explanation || 'No explanation given.', { notes: answer.notes, confidence: answer.confidence });
      const { ok, rejected } = normalize(job, answer.edits);
      for (const e of ok) ev(job, 'edit', `Update ${e.file}`, { diff: diffOf(e) });
      for (const r of rejected) ev(job, 'warn', `Edit refused: ${r.file}${r.from ? ` lines ${r.from}-${r.to}` : ''}`, { detail: r.reason });
      job.explanation = answer.explanation;
      job.notes = answer.notes;
      job.confidence = rejected.length && !ok.length ? null : answer.confidence;
      job.edits = ok;
      job.rejected = rejected;
      job.diff = ok.map(diffOf);
      const gaveNone = !(answer.edits || []).length;
      if (!rejected.length || gaveNone || job.route.kind === 'mock' || round === EDIT_REPAIRS) return ok;
      job.convo.push({
        role: 'user',
        content: `Some of your edits could not be used:\n${rejected.map((r) => `- ${r.reason}`).join('\n')}\n\nUse only the line numbers shown in the code above. Send the complete list of edits again, including the ones that were fine.`,
      });
      ev(job, 'repair', `Sent ${rejected.length} problem${rejected.length === 1 ? '' : 's'} back to the model`);
      title = `Asking again (${round + 1} of ${EDIT_REPAIRS})`;
    }
    return job.edits;
  }

  async function send(id) {
    const job = jobs.get(id);
    if (!job || job.stage !== 'preview') throw new Error('This suggestion is not waiting to be sent.');
    guardBudget(job.route);
    job.stage = 'thinking';
    for (const f of job.ctx.files) ev(job, 'read', `Read ${f.path}`, { detail: `lines ${f.from}-${f.to}` });
    if (job.route.kind !== 'mock') job.convo.push({ role: 'user', content: issuePrompt('fix', job.issue, job.ctx, job.previous) });
    (async () => {
      try {
        const ok = await propose(job, `Asking ${job.route.label}`);
        job.stage = ok.length ? 'proposed' : 'no-edits';
      } catch (err) {
        job.error = err.message;
        job.errorCode = err.code || null;
        job.stage = 'error';
      }
    })();
    return view(job);
  }

  // ---- apply and verify ----------------------------------------------------------------------
  function gitDirty(files) {
    try {
      execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    } catch {
      return null; // not a git repository: backups are the only undo
    }
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...files.map((f) => join(root, f))], { encoding: 'utf8' });
    // Porcelain lines are 'XY path': the status columns can start with a space, so no trim before slicing.
    return out.split('\n').filter((l) => l.trim()).map((l) => l.slice(3));
  }

  function apply(id) {
    const job = jobs.get(id);
    if (!job || job.stage !== 'proposed') throw new Error('There is no suggestion ready to apply.');
    const files = [...new Set(job.edits.map((e) => e.file))];
    // Files with uncommitted changes (an earlier kept fix, work in progress) are fine: the backup
    // is an exact copy of the file as it is now, and Revert puts that copy back.
    const dirty = gitDirty(files) || [];
    const backupDir = join(dir, 'ai', job.id);
    job.backups = [];
    for (const f of files) {
      const dest = join(backupDir, f);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, f), dest);
      job.backups.push({ file: f, backup: dest });
    }
    writeEdits(job.edits);
    // What backlens wrote, so Revert can tell whether someone edited the file afterwards.
    job.written = Object.fromEntries(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
    ev(job, 'apply', `Applied ${job.edits.length} edit${job.edits.length === 1 ? '' : 's'} to ${files.join(', ')}`, {
      detail: dirty.length
        ? `a copy of ${dirty.join(', ')} as it was, uncommitted changes included, is kept until you keep or revert`
        : 'backup kept until you keep or revert',
    });
    job.stage = 'verifying';
    deps.pauseWatch(true);
    verify(job)
      .catch((err) => {
        job.error = err.message;
        finish(job, false, err.message);
      })
      .finally(() => deps.pauseWatch(false));
    return view(job);
  }

  function runScript(script, onOutput) {
    return new Promise((resolve) => {
      const child = spawn(deps.pm, ['run', script], { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
      let out = '';
      const keep = (d) => {
        out = (out + String(d).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-6000);
        if (onOutput) onOutput(out);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('exit', (code) => resolve({ code, out }));
      child.on('error', (err) => resolve({ code: 1, out: err.message }));
    });
  }

  const tail = (text, n = 14) => text.trim().split('\n').slice(-n).join('\n');

  /** Apps started from built output (node dist/...) need a build before a restart picks up the change. */
  function needsBuild() {
    const cmd = deps.appCommand();
    const { scripts } = deps.readProject();
    return cmd && /\b(node|bun)\s+[^\s]*(dist|build|out)\//.test(cmd) && scripts.build ? 'build' : null;
  }

  async function typecheck(job) {
    const { scripts } = deps.readProject();
    const script = scripts.typecheck ? 'typecheck' : scripts['type-check'] ? 'type-check' : null;
    if (!script) return { ok: true, skipped: true };
    const e = ev(job, 'cmd', `Typecheck`, { status: 'running', command: `${deps.pm} run ${script}`, output: '' });
    const r = await runScript(script, (out) => (e.output = tail(out)));
    e.status = r.code === 0 ? 'done' : 'fail';
    e.output = r.code === 0 ? 'no type errors' : tail(r.out, 20);
    return { ok: r.code === 0, errors: r.out };
  }

  const median = (list) => {
    const xs = [...list].sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    return Math.round((xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2) * 100) / 100;
  };

  /** What a request cost: the numbers shown before and after a fix. */
  function stats(trace) {
    const count = (kind) => trace.spans.filter((x) => x.kind === kind).length;
    return { status: trace.status, ms: trace.duration, queries: count('db'), redis: count('redis'), http: count('http') };
  }

  function replay(job, payload, port) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        replayWaiters.delete(job.id);
        resolve(null);
      }, 20000);
      replayWaiters.set(job.id, (trace) => {
        clearTimeout(timer);
        replayWaiters.delete(job.id);
        resolve(trace);
      });
      const req = http.request({ host: '127.0.0.1', port, method: payload.method, path: payload.url, headers: { ...payload.headers, 'x-backlens-replay': job.id } });
      req.on('error', () => {});
      if (payload.body) req.write(Buffer.from(payload.body, 'base64'));
      req.end();
    });
  }

  async function verify(job) {
    // 1. Typecheck, sending type errors back to the model and trying again.
    for (let round = 0; ; round++) {
      const t = await typecheck(job);
      if (t.ok) break;
      if (round >= TYPE_REPAIRS || job.route.kind === 'mock') return finish(job, false, 'The change does not typecheck.');
      restoreBackups(job);
      ev(job, 'repair', 'Put the original code back and sent the type errors to the model');
      job.convo.push({
        role: 'user',
        content: `After applying your edits, the typecheck failed:\n\n${tail(t.errors, 40)}\n\nThe files are back to the original code shown earlier, with the same line numbers. Send the complete corrected list of edits.`,
      });
      const ok = await propose(job, `Asking again with the type errors (${round + 1} of ${TYPE_REPAIRS})`);
      if (!ok.length) return finish(job, false, 'The model could not produce a change that typechecks.');
      writeEdits(ok);
      job.written = Object.fromEntries(job.backups.map((b) => [b.file, readSafe(join(root, b.file))]));
      ev(job, 'apply', `Applied ${ok.length} corrected edit${ok.length === 1 ? '' : 's'}`);
    }

    // 2. Rebuild if the app runs built output, then restart it.
    const build = needsBuild();
    if (build) {
      const e = ev(job, 'cmd', 'Build', { status: 'running', command: `${deps.pm} run ${build}`, output: '' });
      const r = await runScript(build, (out) => (e.output = tail(out)));
      e.status = r.code === 0 ? 'done' : 'fail';
      e.output = r.code === 0 ? 'built' : tail(r.out, 20);
      if (r.code !== 0) return finish(job, false, 'The build failed.');
    }
    const restart = ev(job, 'run', 'Restart the app', { status: 'running' });
    const port = await deps.restartApp();
    restart.status = port ? 'done' : 'fail';
    restart.detail = port ? `listening on :${port}` : 'the app did not come back up; see its logs';
    if (!port) return finish(job, false, 'The app did not start after the change.');

    // 3. Replay the request that showed the issue.
    let replayed = false;
    const payload = settings.replay ? deps.getReplay(job.issue.example) : null;
    const original = deps.getTrace(job.issue.example);
    const r = ev(job, 'run', `Replay ${job.issue.route}`, { status: 'running' });
    const isWrite = payload && !['GET', 'HEAD', 'OPTIONS'].includes(payload.method);
    if (isWrite && !settings.replayWrites) {
      r.status = 'skip';
      r.detail = `${payload.method} changes data, so it is not re-sent unless you allow replaying writes in AI settings`;
    } else if (!payload) {
      r.status = 'skip';
      r.detail = settings.replay ? 'the request that showed this issue is no longer in memory; use the page again to record a fresh one' : 'replay is off in AI settings';
    } else {
      // The app has just restarted, so its first request pays for cold caches and new connections.
      // A read is sent once to warm up, and the second one is measured.
      // A just-restarted app is slow for its first requests (cold code, new database
      // connections). A read is sent a few times to warm up, then measured several times and the
      // median kept. A write runs once: replaying it changes data again.
      const samples = [];
      if (!isWrite) for (let i = 0; i < WARMUPS; i++) await replay(job, payload, deps.appPort());
      for (let i = 0; i < (isWrite ? 1 : SAMPLES); i++) {
        const t = await replay(job, payload, deps.appPort());
        if (!t) break;
        samples.push(t);
      }
      const trace = samples.at(-1);
      if (!trace) {
        r.status = 'fail';
        r.detail = 'the replayed request did not finish within 20 s';
        return finish(job, false, 'The replayed request did not come back.');
      }
      replayed = true;
      const still = samples.some((t) => checkTrace(t).some((i) => sameIssue(i, job.issue)));
      const sameClass = original ? Math.floor(trace.status / 100) === Math.floor(original.status / 100) : trace.status < 400;
      // Before: the same route's recorded requests from before the change, not just one of them.
      const earlier = (deps.routeTraces ? deps.routeTraces(job.issue.route) : []).filter((t) => t.status === (original || trace).status);
      const beforeList = earlier.length ? earlier.slice(-SAMPLES) : original ? [original] : [];
      const after = { ...stats(trace), ms: median(samples.map((t) => t.duration)) };
      const before = beforeList.length ? { ...stats(original || beforeList.at(-1)), ms: median(beforeList.map((t) => t.duration)) } : null;
      r.status = !still && sameClass ? 'done' : 'fail';
      r.detail = `before: ${before ? `${before.status}, median ${before.ms} ms of ${beforeList.length} recorded, ${before.queries} queries` : 'no recorded request'}\nafter:  ${after.status}, median ${after.ms} ms of ${samples.length} replays, ${after.queries} queries${still ? ', issue still there' : ', issue gone'}`;
      job.compare = { before, after, beforeRuns: beforeList.length, afterRuns: samples.length, issueGone: !still, warmed: !isWrite };
      job.afterTrace = trace;
      if (trace.status === 401 && original && original.status !== 401) r.detail += '\nThe recorded login may have expired: sign in again and use the page once more.';
      if (r.status === 'fail') return finish(job, false, still ? 'The issue is still there after the change.' : `The request now answers ${trace.status}.`);
    }

    // 4. Run the tests, with their output live in the feed.
    let tested = false;
    const cfg = deps.config();
    if (cfg && cfg.test) {
      const t = ev(job, 'cmd', 'Tests', { status: 'running', command: `${deps.pm} run ${cfg.test}`, output: '' });
      const follow = setInterval(() => (t.output = deps.testsTail()), 700);
      const report = await deps.runTests();
      clearInterval(follow);
      tested = true;
      const still = report && report.issues.some((i) => i.route === job.issue.route && sameIssue(i, job.issue));
      t.status = report && report.exitCode === 0 && !still ? 'done' : 'fail';
      t.output = !report ? 'tests did not report' : report.exitCode !== 0 ? tail(deps.testsTail(), 20) : still ? 'tests pass, but the issue still shows in test traffic' : `tests pass, ${report.requests} requests checked, issue not seen`;
      if (t.status === 'fail') return finish(job, false, report && report.exitCode !== 0 ? 'The tests fail with this change.' : 'The issue still shows in test traffic.');
    }
    if (!replayed && !tested) return finish(job, false, 'Nothing could check this fix: no recorded request and no test script.', true);
    return finish(job, true, replayed && tested ? 'Issue gone in the replayed request, and the tests pass.' : replayed ? 'Issue gone in the replayed request.' : 'Tests pass and the issue is gone from test traffic.');
  }

  function finish(job, verified, reason, unverifiable = false) {
    job.verified = verified;
    job.verdict = reason;
    job.stage = verified ? 'verified' : unverifiable ? 'unverified' : 'failed';
    ev(job, 'verdict', verified ? `Proven: ${reason}` : reason, { status: verified ? 'done' : unverifiable ? 'warn' : 'fail' });
    return job;
  }

  function cleanup(job) {
    if (job.backups && job.backups.length) rmSync(join(dir, 'ai', job.id), { recursive: true, force: true });
    job.backups = [];
  }

  function keep(id) {
    const job = jobs.get(id);
    if (!job || !['verified', 'unverified', 'failed'].includes(job.stage)) throw new Error('Nothing to keep.');
    append(historyFile, { at: new Date().toISOString(), type: job.issue.type, tier: job.route.tier || job.route.kind, model: job.route.model, verified: Boolean(job.verified), kept: true });
    cleanup(job);
    job.stage = 'kept';
    // The measured request joins the normal list, and the issue leaves it until a request shows it again.
    if (deps.markFixed) deps.markFixed(job.issue.key, job.afterTrace && job.compare && job.compare.issueGone ? job.afterTrace : null);
    ev(job, 'done', 'Kept. Review it in your editor and commit when ready.');
    return view(job);
  }

  async function revert(id) {
    const job = jobs.get(id);
    if (!job || !job.backups || !job.backups.length) throw new Error('Nothing to revert.');
    // Never overwrite edits made after the fix was applied.
    const changed = job.backups.filter((b) => job.written && job.written[b.file] !== undefined && readSafe(join(root, b.file)) !== job.written[b.file]);
    if (changed.length) {
      throw new Error(`${changed.map((b) => b.file).join(', ')} changed after the fix was applied, so backlens did not overwrite it. The version from before the fix is at ${changed.map((b) => relative(root, b.backup)).join(', ')}.`);
    }
    restoreBackups(job);
    append(historyFile, { at: new Date().toISOString(), type: job.issue.type, tier: job.route.tier || job.route.kind, model: job.route.model, verified: Boolean(job.verified), kept: false });
    cleanup(job);
    job.stage = 'reverting';
    ev(job, 'apply', 'Put the original files back');
    deps.pauseWatch(true);
    (async () => {
      const e = ev(job, 'run', 'Restart the app', { status: 'running' });
      const port = await deps.restartApp();
      e.status = port ? 'done' : 'fail';
      e.detail = port ? `listening on :${port}` : 'see the app logs';
      job.stage = 'reverted';
    })().finally(() => setTimeout(() => deps.pauseWatch(false), 1000));
    return view(job);
  }

  /** Stops a model that is still answering. */
  function stop(id) {
    const job = jobs.get(id);
    if (!job || job.stage !== 'thinking' || !job.abort) throw new Error('Nothing is running.');
    job.abort.abort();
    return view(job);
  }

  async function escalate(id) {
    const job = jobs.get(id);
    if (!job || job.attempt > 0) throw new Error('A stronger model was already tried for this issue.');
    if (!['reverted', 'no-edits', 'error'].includes(job.stage)) throw new Error('Revert this fix before trying a stronger model.');
    return startFix(job.issueKey, 1, { reason: job.verdict || job.error || job.notes || 'no usable edits' });
  }

  /** Called by the server when a replayed request's trace arrives. */
  function onReplayTrace(trace) {
    const waiter = replayWaiters.get(trace.replayOf);
    if (waiter) waiter(trace);
  }

  /** Tests a pasted key (free) and saves it only if Claude accepts it. */
  async function setKey(key) {
    key = typeof key === 'string' ? key.trim() : '';
    if (!looksLikeKey(key)) throw new Error('That does not look like a Claude API key. It starts with sk-ant-.');
    const problem = await testKey(key);
    if (problem) throw new Error(problem);
    saveKey(key);
    return status();
  }

  async function forgetKey() {
    removeKey();
    return status();
  }

  async function pullModel(model) {
    startPull(model);
    return status();
  }

  async function stopPullModel() {
    stopPull();
    return status();
  }

  return { setKey, forgetKey, pullModel, stopPullModel, status, saveSettings, explain, startFix, getFix, send, apply, keep, revert, escalate, stop, onReplayTrace, replayEnabled: () => settings.replay };
}
