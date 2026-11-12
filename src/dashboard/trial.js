import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkTrace, routeOf } from '../analysis/index.js';
import { record } from '../evidence/ledger.js';
import { timing } from '../shared/compare.js';
import { projectDir } from '../shared/project-config.js';
import { SAFE_METHODS } from '../shared/replay-policy.js';
import { applyFix, checkFixes, rankFixes } from '../trial/rank.js';
import { sandboxCheck } from './sandbox-policy.js';

/**
 * The counterfactual lab: an agent proposes a few fixes for one request; backlens applies each in
 * turn, restarts the app, replays the request (queries, time, status, issues), runs the diff on
 * the routes the fix can reach and the tests, then puts the files back exactly. The best one is
 * reported, and kept only when asked.
 *
 * Safety: like the mutation lab. Files are backed up before each fix; `active.json` lists them so
 * the next start puts them back if backlens is killed mid-run (recoverTrial). The app's file watcher
 * is paused so only backlens restarts it.
 */

const SAMPLES = 5;
const dirOf = (root) => join(projectDir(root), 'trial');
const marker = (root) => join(dirOf(root), 'active.json');

/** Puts back files a killed run left changed. Returns them, or []. */
export function recoverTrial(root) {
  try {
    const m = JSON.parse(readFileSync(marker(root), 'utf8'));
    for (const f of m.files) {
      if (f.backup) copyFileSync(f.backup, join(root, f.file));
      else rmSync(join(root, f.file), { force: true });
    }
    rmSync(dirOf(root), { recursive: true, force: true });
    return m.files.map((f) => f.file);
  } catch {
    return [];
  }
}

function readOrNull(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }
}

export async function runTrial({ root, store, replayer, procs, behavior, getConfig, id, fixes, keep = false, tests = true }) {
  const bad = checkFixes(fixes);
  if (bad) return { error: bad };
  const original = store.findTrace(id);
  const payload = original && store.replayOf(id);
  if (!payload) return { error: 'No replayable recorded request with that id. List recent requests first.' };
  const write = !SAFE_METHODS.includes(payload.method);
  if (write) {
    const check = sandboxCheck(original);
    if (!check.ok) return { error: `Not tried: ${check.why}.` };
  }
  // Every fix must apply cleanly before anything is touched.
  const planned = [];
  for (const f of fixes) {
    const a = applyFix(f, (file) => readOrNull(root, file));
    if (a.error) return { error: a.error };
    planned.push({ name: f.name, files: a.files });
  }
  const route = routeOf(original.method, original.url, original.template);
  const p = procs();
  const runTests = tests && getConfig() && getConfig().test;
  const headers = write ? { 'x-backlens-sandbox': '1' } : null;

  const measure = async () => {
    const port = await p.restartApp();
    if (!port) return { error: 'the app did not start with this change' };
    const traces = await replayer.measure(payload, port, { samples: SAMPLES, headers, maxWarmups: write ? 6 : undefined });
    if (!traces.length) return { error: 'the request did not answer' };
    if (write && traces.some((t) => !t.sandbox || t.sandbox.leaked || !t.sandbox.rolledBack)) return { error: 'the sandbox did not hold; stopped', breach: true };
    const last = traces.at(-1);
    const t = timing(traces.map((x) => x.duration));
    return { status: last.status, queries: last.spans.filter((s) => s.kind === 'db').length, ms: t.ms, lo: t.lo, hi: t.hi, issues: checkTrace(last).map((i) => i.title) };
  };

  const base = { name: 'as is', ...(await measure()) };
  if (base.error) return { error: `The code as it is could not be measured: ${base.error}.` };
  const trials = [];
  mkdirSync(dirOf(root), { recursive: true });
  p.pauseWatch(true);
  try {
    for (const plan of planned) {
      const files = Object.keys(plan.files);
      const saved = files.map((file, i) => {
        const backup = existsSync(join(root, file)) ? join(dirOf(root), `backup-${i}`) : null;
        if (backup) copyFileSync(join(root, file), backup);
        return { file, backup };
      });
      writeFileSync(marker(root), JSON.stringify({ files: saved }));
      const t = { name: plan.name, files };
      try {
        for (const file of files) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), plan.files[file]);
        }
        Object.assign(t, await measure());
        if (!t.error) {
          // Only the routes this fix can reach (the working tree now holds it).
          const d = behavior.list() ? await behavior.diff({ changed: true }) : null;
          const hit = d && d.results ? d.results.filter((x) => x.findings.some((f) => f.kind === 'broken')) : [];
          t.broken = hit.length ? hit.map((x) => `${x.route}: ${x.findings[0].what}`).slice(0, 3) : null;
          if (runTests) {
            const report = await p.runTests();
            t.tests = Boolean(report && report.exitCode === 0);
          }
        }
      } finally {
        for (const s of saved) {
          if (s.backup) copyFileSync(s.backup, join(root, s.file));
          else rmSync(join(root, s.file), { force: true });
        }
        rmSync(marker(root), { force: true });
      }
      trials.push(t);
      if (t.breach) break;
    }
  } finally {
    rmSync(dirOf(root), { recursive: true, force: true });
    p.pauseWatch(false);
  }
  const rank = rankFixes(base, trials);
  let kept = false;
  if (keep && rank.winner) {
    const plan = planned.find((x) => x.name === rank.winner);
    for (const [file, text] of Object.entries(plan.files)) writeFileSync(join(root, file), text);
    kept = true;
  }
  await p.restartApp();
  record(root, 'trial', { route, tried: trials.length, winner: rank.winner, kept, base: { queries: base.queries, ms: base.ms }, trials: trials.map((t) => ({ name: t.name, queries: t.queries, ms: t.ms, status: t.status, broken: Boolean(t.broken), tests: t.tests, error: t.error || null })) });
  return { route, base, trials, ...rank, kept, tests: Boolean(runTests) };
}
