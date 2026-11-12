import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARK } from '../diff/compare.js';
import { record } from '../evidence/ledger.js';
import { api, findSessions } from '../mcp/session.js';
import { projectDir } from '../shared/project-config.js';

/**
 * The verification gate, as an agent's Stop hook (`backlens hook stop [--harness claude|codex|cursor]`).
 * Claude Code and Codex share one format (decision: block + reason; stop_hook_active on retries);
 * Cursor answers with followup_message and counts retries in loop_count. When the agent is about
 * to finish a turn and files changed since the last check, it runs the behavior diff:
 *
 *   broken   -> blocks the stop and hands the agent the reason, so it fixes the break now
 *   changed  -> lets it stop, tells the user in one or two lines, and accepts those routes, so the
 *               next turn compares against them (each change is reported once)
 *   nothing  -> silent
 *
 * It never gets in the way when it cannot help: no backlens running, no file changes, a diff that
 * fails or runs past the budget -> the stop goes through (with a one-line note when useful).
 * A second block in a row is never sent (stop_hook_active): the agent gets one chance per turn,
 * then the user is told.
 */

export const BUDGET_MS = 45_000;
const MAX_REASON_ROUTES = 5;

const stateFile = (root) => join(projectDir(root), 'hook-state.json');

function readState(root) {
  try {
    return JSON.parse(readFileSync(stateFile(root), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeState(root, state) {
  try {
    mkdirSync(projectDir(root), { recursive: true });
    writeFileSync(stateFile(root), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {}
}

/** A hash of the working tree's changes (tracked diff + untracked files), or null outside git. */
export function treeState(root) {
  try {
    const opts = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
    const status = execFileSync('git', ['status', '--porcelain=v1', '-uall', '--', '.', ':(exclude).backlens'], opts);
    const diff = execFileSync('git', ['diff', 'HEAD', '--', '.', ':(exclude).backlens'], opts);
    return createHash('sha256').update(status).update('\0').update(diff).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

const withBudget = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`took longer than ${ms / 1000} s`)), ms))]);

/** The lines an agent or user reads for a set of diff results. */
export function findingLines(results, kinds, max = MAX_REASON_ROUTES) {
  const picked = results.filter((r) => r.findings.some((f) => kinds.includes(f.kind)));
  const lines = [];
  for (const r of picked.slice(0, max)) {
    lines.push(r.route);
    for (const f of r.findings.filter((x) => kinds.includes(x.kind))) lines.push(`  ${MARK[f.kind]} ${f.what}`);
  }
  if (picked.length > max) lines.push(`  ...and ${picked.length - max} more routes (backlens diff shows all)`);
  return lines;
}

/**
 * Decides what the hook answers, from the hook input and a diff result. Pure, so it is tested
 * without Claude Code: returns { output (object for stdout, or null for silence), accept (routes),
 * saveTree (whether this tree counts as checked) }.
 */
export function decide(input, d) {
  if (d.error) return { output: { systemMessage: `backlens: behavior diff did not run: ${d.error}` }, accept: [], saveTree: false };
  if (d.created) return { output: d.captured && d.captured.length ? { systemMessage: `backlens: baseline taken (${d.captured.length} routes); later turns are checked against it.` } : null, accept: [], saveTree: true };
  if (d.broken) {
    const lines = findingLines(d.results, ['broken']);
    const routes = d.results.filter((r) => r.findings.some((f) => f.kind === 'broken')).map((r) => r.route);
    if (input.stop_hook_active)
      return { output: { systemMessage: [`backlens: still broken after the agent's retry (${routes.length} route${routes.length === 1 ? '' : 's'}):`, ...lines].join('\n') }, accept: [], saveTree: false };
    const reason = [
      `backlens replayed the app's routes after your change and ${routes.length === 1 ? 'one route broke' : `${routes.length} routes broke`}:`,
      ...lines,
      'Fix this before finishing. If the change is intended, say so and call the backlens accept tool for those routes',
      `(or run: npx backlens accept ${routes.map((r) => `"${r}"`).join(' ')}).`,
    ].join('\n');
    return { output: { decision: 'block', reason }, accept: [], saveTree: false };
  }
  const changed = d.results.filter((r) => r.findings.length).map((r) => r.route);
  if (!changed.length) return { output: null, accept: [], saveTree: true };
  const lines = findingLines(d.results, ['changed', 'better'], 3);
  return { output: { systemMessage: [`backlens: ${changed.length} route${changed.length === 1 ? '' : 's'} behave differently after this turn (accepted as the new baseline):`, ...lines].join('\n') }, accept: changed, saveTree: true };
}

/** One shape for every harness's hook input: { cwd, retry, session, skip }. */
export function normalizeInput(raw, harness) {
  const input = raw && typeof raw === 'object' ? raw : {};
  if (harness === 'cursor') {
    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
    return { cwd: roots[0] || null, retry: Number(input.loop_count) > 0, session: input.conversation_id || null, skip: input.status && input.status !== 'completed' };
  }
  return { cwd: input.cwd || null, retry: Boolean(input.stop_hook_active), session: input.session_id || null, skip: false };
}

/** The decision in a harness's own words. Claude Code and Codex: as is. Cursor: a block becomes a follow-up message; it has no user-only note. */
export function toHarness(output, harness) {
  if (!output || harness !== 'cursor') return output;
  return output.decision === 'block' ? { followup_message: output.reason } : null;
}

export async function runStopHook({ stdin, harness = 'claude', cwd = process.cwd(), now = Date.now }) {
  let raw = {};
  try {
    raw = JSON.parse(stdin || '{}') || {};
  } catch {}
  const hookInput = normalizeInput(raw, harness);
  if (hookInput.skip) return null; // Cursor: the turn was aborted or failed; nothing to check.
  const input = { stop_hook_active: hookInput.retry, session_id: hookInput.session };
  const session = findSessions(hookInput.cwd || cwd)[0];
  if (!session) return null; // backlens is not running for this project: nothing to check.
  const root = session.root;
  const state = readState(root);
  const tree = treeState(root);
  // Nothing changed since the last check that passed: stay out of the way.
  if (tree && state.tree === tree && !state.broken) return null;

  const started = now();
  let d;
  try {
    d = await withBudget(api(session, 'POST', '/api/behavior/diff', {}), BUDGET_MS);
  } catch (err) {
    d = { error: err.message };
  }
  const { output, accept, saveTree } = decide(input, d);
  let accepted = [];
  if (accept.length) {
    try {
      await withBudget(api(session, 'POST', '/api/behavior/accept', { routes: accept }), 15_000);
      accepted = accept;
    } catch {}
  }
  writeState(root, { tree: saveTree ? tree : state.tree || null, broken: Boolean(d.broken), at: now() });
  record(root, 'hook', {
    harness,
    session: typeof input.session_id === 'string' ? input.session_id.slice(0, 64) : null,
    verdict: d.error ? 'error' : d.created ? 'baseline' : d.broken ? 'broken' : accepted.length ? 'changed' : 'clean',
    blocked: Boolean(output && output.decision === 'block'),
    retry: Boolean(input.stop_hook_active),
    accepted,
    ms: now() - started,
  });
  return toHarness(output, harness);
}

/** CLI entry: reads the hook input from stdin, prints the answer, always exits 0. */
export async function runStopHookCommand({ harness = 'claude' } = {}) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let out = null;
  try {
    out = await runStopHook({ stdin: Buffer.concat(chunks).toString('utf8'), harness });
  } catch (err) {
    out = harness === 'cursor' ? null : { systemMessage: `backlens hook: ${err.message}` };
  }
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
