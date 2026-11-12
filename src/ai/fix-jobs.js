import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { checkTrace } from '../analysis/index.js';
import { projectDir } from '../shared/project-config.js';
import { REPLAY, SAFE_METHODS } from '../shared/replay-policy.js';
import { compareTimings, timing } from '../shared/compare.js';
import { buildContext } from './context.js';
import { diffOf, normalizeEdits, sameIssue, writeEdits } from './edits.js';
import { ask, issuePrompt } from './providers/index.js';
import { route } from './router.js';
import { promiseAll } from './templates.js';
import { gitDirty, needsBuild, readSafe, runScript, tail, typecheckScript } from './workspace.js';

/**
 * Fix jobs. A fix runs like a careful developer at a terminal, and every step is written to a live
 * feed the dashboard shows: read the code, ask the model, check each edit fits the code (sending
 * problems back, up to twice), apply (keeping an exact copy of each file as it was, uncommitted
 * changes included), typecheck (sending type errors back, up to twice), rebuild if needed, restart,
 * replay the request that showed the issue, run the tests. Only then is it called proven.
 *
 * Stages: preview → thinking → proposed | no-edits | error → verifying → verified | unverified |
 * failed → kept | reverting → reverted. Templates (Promise.all, indexes) skip the model.
 */

// How many recorded requests stand in for the before when no warm measurement could be taken.
const SAMPLES = REPLAY.samples;
const EDIT_REPAIRS = 2;
const TYPE_REPAIRS = 2;

/** What a request cost: the numbers shown before and after a fix. */
function stats(trace) {
  const count = (kind) => trace.spans.filter((x) => x.kind === kind).length;
  return { status: trace.status, ms: trace.duration, queries: count('db'), redis: count('redis'), http: count('http') };
}

export function createFixJobs({ root, deps, settings }) {
  const dir = projectDir(root);
  const jobs = new Map();
  const hasTests = () => Boolean(deps.config()?.test);
  const normalize = (job, raw) => normalizeEdits(root, job.ctx.files, raw);
  const diff = (e) => diffOf(root, e);

  // ---- the live feed ---------------------------------------------------------------------
  function ev(job, kind, title, extra = {}) {
    const e = { at: Date.now() - job.at, kind, title, status: 'done', ...extra };
    job.events.push(e);
    return e;
  }

  const view = (job) => {
    const { ctx, issue, backups, convo, abort, afterTrace, written, ...rest } = job;
    return { ...rest, now: Date.now(), issueTitle: issue.title, issueRoute: issue.route, spentTodayUsd: settings.spentToday(), budgetUsd: settings.get().dailyBudgetUsd };
  };

  async function startFix(issueKey, attempt = 0, previous = null) {
    const issue = deps.getIssue(issueKey);
    if (!issue) throw new Error('That issue is gone. Refresh the list.');
    const ctx = buildContext(root, issue);
    const s = await settings.resolved();
    const routeInfo = route({ task: 'fix', issue, ctx, settings: s, history: settings.history(), attempt, hasTests: hasTests() });
    const job = { id: randomUUID(), issueKey, issue, ctx, attempt, previous, route: routeInfo, preview: ctx.preview, tokens: ctx.tokens, stage: 'preview', events: [], edits: [], diff: [], at: Date.now(), costUsd: 0, convo: [] };
    if (routeInfo.template === 'promise-all') {
      jobs.set(job.id, job);
      for (const f of ctx.files) ev(job, 'read', `Read ${f.path}`, { detail: `lines ${f.from}-${f.to}` });
      const t = promiseAll(root, issue);
      if (t.edits) {
        const { ok, rejected } = normalize(job, t.edits);
        if (ok.length && !rejected.length) {
          ev(job, 'say', t.explanation, { confidence: 'high' });
          for (const e of ok) ev(job, 'edit', `Update ${e.file}`, { diff: diff(e) });
          Object.assign(job, { stage: 'proposed', explanation: t.explanation, confidence: 'high', edits: ok, rejected: [], diff: ok.map(diff) });
          return view(job);
        }
      }
      // Not the simple shape: hand it to a model, with the reason.
      const reason = t.reason || 'the rewrite did not fit the code';
      job.route = route({ task: 'fix', issue, ctx, settings: s, history: settings.history(), attempt, hasTests: hasTests(), noTemplate: true });
      job.route.reasons.unshift(`backlens could not rewrite this itself: ${reason}`);
      job.events = [];
      return view(job);
    }
    if (routeInfo.kind === 'template') {
      const sql = (issue.fix.match(/CREATE INDEX[^;]*;/) || [''])[0];
      Object.assign(job, {
        stage: 'template',
        explanation: `${issue.title}. Postgres reads every row to find matches. An index on those columns lets it jump straight to them.`,
        sql,
        notes: 'Run this in a migration. CONCURRENTLY builds the index without locking writes, and must run outside a transaction.',
      });
    }
    jobs.set(job.id, job);
    return view(job);
  }

  function getFix(id) {
    const job = jobs.get(id);
    return job ? view(job) : null;
  }

  function restoreBackups(job) {
    for (const b of job.backups || []) copyFileSync(b.backup, join(root, b.file));
  }

  // ---- asking, with repairs ------------------------------------------------------------------
  async function askOnce(job, title) {
    settings.guardBudget(job.route);
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
      settings.recordUsage('fix', job.route, result.costUsd);
      job.costUsd += result.costUsd || 0;
      e.status = 'done';
      e.detail = `${((Date.now() - started) / 1000).toFixed(1)} s${result.usage && result.usage.output_tokens ? `, ${result.usage.output_tokens} tokens` : ''}${result.costUsd ? `, $${result.costUsd.toFixed(4)}` : ''}`;
      if (job.route.kind !== 'mock') job.convo.push({ role: 'assistant', content: result.raw || JSON.stringify(result.data) });
      return result.data || {};
    } catch (err) {
      if (err.costUsd) {
        settings.recordUsage('fix', job.route, err.costUsd);
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
      for (const e of ok) ev(job, 'edit', `Update ${e.file}`, { diff: diff(e) });
      for (const r of rejected) ev(job, 'warn', `Edit refused: ${r.file}${r.from ? ` lines ${r.from}-${r.to}` : ''}`, { detail: r.reason });
      job.explanation = answer.explanation;
      job.notes = answer.notes;
      job.confidence = rejected.length && !ok.length ? null : answer.confidence;
      job.edits = ok;
      job.rejected = rejected;
      job.diff = ok.map(diff);
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
    settings.guardBudget(job.route);
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
  function apply(id) {
    const job = jobs.get(id);
    if (!job || job.stage !== 'proposed') throw new Error('There is no suggestion ready to apply.');
    job.stage = 'verifying';
    deps.pauseWatch(true);
    measureBefore(job)
      .then(() => {
        writeFiles(job);
        return verify(job);
      })
      .catch((err) => {
        job.error = err.message;
        finish(job, false, err.message);
      })
      .finally(() => deps.pauseWatch(false));
    return view(job);
  }

  /** Backs up each file as it is now, then writes the edits. */
  function writeFiles(job) {
    const files = [...new Set(job.edits.map((e) => e.file))];
    // Files with uncommitted changes (an earlier kept fix, work in progress) are fine: the backup
    // is an exact copy of the file as it is now, and Revert puts that copy back.
    const dirty = gitDirty(root, files) || [];
    const backupDir = join(dir, 'ai', job.id);
    job.backups = [];
    for (const f of files) {
      const dest = join(backupDir, f);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, f), dest);
      job.backups.push({ file: f, backup: dest });
    }
    writeEdits(root, job.edits);
    // What backlens wrote, so Revert can tell whether someone edited the file afterwards.
    job.written = Object.fromEntries(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
    ev(job, 'apply', `Applied ${job.edits.length} edit${job.edits.length === 1 ? '' : 's'} to ${files.join(', ')}`, {
      detail: dirty.length ? `a copy of ${dirty.join(', ')} as it was, uncommitted changes included, is kept until you keep or revert` : 'backup kept until you keep or revert',
    });
  }

  /**
   * Before any file changes: the request that showed the issue, replayed on a freshly restarted app
   * with the old code, measured the same way as the after. Reads only; skipped when replay is
   * off, the request is gone or the app is not running (the recorded traffic is then shown instead).
   */
  async function measureBefore(job) {
    job.beforeWarm = null;
    const payload = settings.get().replay ? deps.getReplay(job.issue.example) : null;
    if (!payload || !SAFE_METHODS.includes(payload.method) || !deps.appPort() || !deps.replayer) return;
    const e = ev(job, 'run', `Measure ${job.issue.route} before the change`, { status: 'running' });
    // The after is measured on a just-restarted app; the before must be too, or a long-running
    // process (much faster on a dev machine) makes the change look slower.
    const port = await deps.restartApp();
    if (!port) {
      e.status = 'skip';
      e.detail = 'the app did not come back after a restart; the recorded traffic is used as the before';
      return;
    }
    const samples = await deps.replayer.measure(payload, port);
    if (!samples.length) {
      e.status = 'skip';
      e.detail = 'the request did not come back; the recorded traffic is used as the before';
      return;
    }
    job.beforeWarm = { ...stats(samples.at(-1)), ...timing(samples.map((t) => t.duration)) };
    e.detail = `median ${job.beforeWarm.ms} ms (${job.beforeWarm.lo}-${job.beforeWarm.hi}) of ${samples.length} warm replays, ${job.beforeWarm.queries} queries`;
  }

  async function typecheck(job) {
    const script = typecheckScript(deps.readProject().scripts);
    if (!script) return { ok: true, skipped: true };
    const e = ev(job, 'cmd', `Typecheck`, { status: 'running', command: `${deps.pm} run ${script}`, output: '' });
    const r = await runScript(deps.pm, root, script, (out) => (e.output = tail(out)));
    e.status = r.code === 0 ? 'done' : 'fail';
    e.output = r.code === 0 ? 'no type errors' : tail(r.out, 20);
    return { ok: r.code === 0, errors: r.out };
  }

  /** Sends the recorded request again against the changed app, waiting for its trace (or null). */
  const replay = (job, payload, port) => (deps.replayer ? deps.replayer.send(payload, port, job.id) : Promise.resolve(null));

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
      writeEdits(root, ok);
      job.written = Object.fromEntries(job.backups.map((b) => [b.file, readSafe(join(root, b.file))]));
      ev(job, 'apply', `Applied ${ok.length} corrected edit${ok.length === 1 ? '' : 's'}`);
    }

    // 2. Rebuild if the app runs built output, then restart it.
    const build = needsBuild(deps.appCommand && deps.appCommand(), deps.readProject().scripts);
    if (build) {
      const e = ev(job, 'cmd', 'Build', { status: 'running', command: `${deps.pm} run ${build}`, output: '' });
      const r = await runScript(deps.pm, root, build, (out) => (e.output = tail(out)));
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
    const s = settings.get();
    const payload = s.replay ? deps.getReplay(job.issue.example) : null;
    const original = deps.getTrace(job.issue.example);
    const r = ev(job, 'run', `Replay ${job.issue.route}`, { status: 'running' });
    const isWrite = payload && !SAFE_METHODS.includes(payload.method);
    if (isWrite && !s.replayWrites) {
      r.status = 'skip';
      r.detail = `${payload.method} changes data, so it is not re-sent unless you allow replaying writes in AI settings`;
    } else if (!payload) {
      r.status = 'skip';
      r.detail = s.replay ? 'the request that showed this issue is no longer in memory; use the page again to record a fresh one' : 'replay is off in AI settings';
    } else {
      // A read is warmed up until it stops getting faster, then measured several times (see
      // dashboard/replay.js). A write runs once: replaying it changes data again.
      const samples = [];
      if (!isWrite && deps.replayer) samples.push(...(await deps.replayer.measure(payload, deps.appPort())));
      else {
        const t = await replay(job, payload, deps.appPort());
        if (t) samples.push(t);
      }
      const trace = samples.at(-1);
      if (!trace) {
        r.status = 'fail';
        r.detail = `the replayed request did not finish within ${REPLAY.timeoutMs / 1000} s`;
        return finish(job, false, 'The replayed request did not come back.');
      }
      replayed = true;
      const still = samples.some((t) => checkTrace(t).some((i) => sameIssue(i, job.issue)));
      const sameClass = original ? Math.floor(trace.status / 100) === Math.floor(original.status / 100) : trace.status < 400;
      // Before: the warm measurement taken before the files changed; failing that, the route's
      // recorded requests (which include cold ones, so no time verdict is drawn from them).
      const after = { ...stats(trace), ...timing(samples.map((t) => t.duration)) };
      let before = job.beforeWarm;
      let beforeKind = 'warm';
      if (!before) {
        const earlier = (deps.routeTraces ? deps.routeTraces(job.issue.route) : []).filter((t) => t.status === (original || trace).status);
        const beforeList = earlier.length ? earlier.slice(-SAMPLES) : original ? [original] : [];
        before = beforeList.length ? { ...stats(original || beforeList.at(-1)), ...timing(beforeList.map((t) => t.duration)) } : null;
        beforeKind = 'recorded';
      }
      const change = before && beforeKind === 'warm' && !isWrite ? compareTimings(before, after) : null;
      r.status = !still && sameClass ? 'done' : 'fail';
      r.detail = `before: ${before ? `${before.status}, median ${before.ms} ms of ${before.runs} ${beforeKind === 'warm' ? 'warm replays' : 'recorded requests'}, ${before.queries} queries` : 'no recorded request'}\nafter:  ${after.status}, median ${after.ms} ms of ${samples.length} replays, ${after.queries} queries${still ? ', issue still there' : ', issue gone'}${change ? `\ntime: ${change.verdict === 'same' ? 'within noise' : `${change.verdict} by ${Math.abs(change.delta)} ms (${change.pct}%)`}` : ''}`;
      job.compare = { before, after, beforeKind, change, beforeRuns: before ? before.runs : 0, afterRuns: samples.length, issueGone: !still, warmed: !isWrite };
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

  const historyRow = (job, kept) => ({ at: new Date().toISOString(), type: job.issue.type, tier: job.route.tier || job.route.kind, model: job.route.model, verified: Boolean(job.verified), kept });

  function keep(id) {
    const job = jobs.get(id);
    if (!job || !['verified', 'unverified', 'failed'].includes(job.stage)) throw new Error('Nothing to keep.');
    settings.appendHistory(historyRow(job, true));
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
      throw new Error(
        `${changed.map((b) => b.file).join(', ')} changed after the fix was applied, so backlens did not overwrite it. The version from before the fix is at ${changed.map((b) => relative(root, b.backup)).join(', ')}.`,
      );
    }
    restoreBackups(job);
    settings.appendHistory(historyRow(job, false));
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

  return { startFix, getFix, send, apply, keep, revert, stop, escalate };
}
