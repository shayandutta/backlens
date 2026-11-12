import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { record } from '../evidence/ledger.js';
import { apply, mutantsOf } from '../mutate/mutants.js';
import { projectDir } from '../shared/project-config.js';

/**
 * The mutation lab: are the app's guards protected by anything? For the files real requests ran
 * through, it breaks one guard at a time (removes an auth check or access decorator, shifts a
 * boundary), restarts the app, runs the behavior diff and the tests, and puts the file back
 * exactly. A mutant nothing noticed is a gap: a change an agent could make without any signal.
 *
 * Safety: one file is changed at a time, from an exact backup; an `active.json` marker lets the
 * next start put the file back if backlens is killed mid-run (see recover()). The app's file
 * watcher is paused so only backlens restarts it.
 */

const DEFAULT_MAX = 8;
const SOURCE = /\.(ts|tsx|js|mjs|cjs|mts|cts)$/;
const TESTY = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const ORDER = { 'remove-decorator': 0, 'remove-guard': 1, boundary: 2 };

const dirOf = (root) => join(projectDir(root), 'mutation');
const marker = (root) => join(dirOf(root), 'active.json');

/** Puts back a file a killed run left mutated. Returns the file restored, or null. */
export function recover(root) {
  try {
    const m = JSON.parse(readFileSync(marker(root), 'utf8'));
    copyFileSync(m.backup, join(root, m.file));
    rmSync(dirOf(root), { recursive: true, force: true });
    return m.file;
  } catch {
    return null;
  }
}

function typescriptFor(root) {
  for (const load of [() => createRequire(join(root, 'package.json'))('typescript'), () => createRequire(import.meta.url)('typescript')]) {
    try {
      const ts = load();
      if (ts && typeof ts.createSourceFile === 'function') return ts;
    } catch {}
  }
  return null;
}

/** App source files real requests ran through, most-used first. */
function filesSeen(root, store) {
  const count = new Map();
  for (const t of [...store.traces, ...store.testRun.traces]) {
    const seen = new Set();
    for (const s of t.spans || []) for (const f of s.frames || []) if (f.file) seen.add(f.file);
    for (const f of seen) count.set(f, (count.get(f) || 0) + 1);
  }
  return [...count]
    .filter(([f]) => SOURCE.test(f) && !TESTY.test(f) && !f.includes('node_modules') && existsSync(join(root, f)))
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);
}

export async function runMutations({ root, store, procs, behavior, getConfig, max = DEFAULT_MAX, tests = true, onProgress = () => {} }) {
  const restored = recover(root);
  const ts = typescriptFor(root);
  if (!ts) return { error: 'The mutation lab needs TypeScript (the typescript package) in the project to read the code safely.' };
  const files = filesSeen(root, store);
  if (!files.length) return { error: 'No app code recorded yet: use the app (or run the tests) so backlens knows which files serve requests.' };
  const p = procs();
  const runTests = tests && getConfig() && getConfig().test;

  const mutants = files
    .flatMap((f) => mutantsOf(f, readFileSync(join(root, f), 'utf8'), ts))
    .sort((a, b) => ORDER[a.operator] - ORDER[b.operator])
    .slice(0, max);
  if (!mutants.length) return { error: `No guards found in the ${files.length} files requests ran through.`, files: files.length };

  // A baseline to diff against, taken on the unmutated code.
  if (!behavior.list()) await behavior.diff();

  const results = [];
  mkdirSync(dirOf(root), { recursive: true });
  p.pauseWatch(true);
  try {
    for (const [n, m] of mutants.entries()) {
      onProgress({ at: n + 1, of: mutants.length, mutant: m.describe });
      const file = join(root, m.file);
      const backup = join(dirOf(root), 'backup');
      const original = readFileSync(file, 'utf8');
      copyFileSync(file, backup);
      writeFileSync(marker(root), JSON.stringify({ file: m.file, backup }));
      const r = { file: m.file, line: m.line, operator: m.operator, describe: m.describe, caughtByDiff: false, caughtByTests: null, verdict: null, detail: [] };
      try {
        writeFileSync(file, apply(original, m));
        const port = await p.restartApp();
        if (!port) {
          r.verdict = 'invalid';
          r.detail.push('the app did not start with this change');
        } else {
          const d = await behavior.diff();
          const hit = (d.results || []).filter((x) => x.findings.some((f) => f.kind === 'broken' || f.kind === 'changed'));
          r.caughtByDiff = hit.length > 0;
          if (hit.length) r.detail.push(`diff: ${hit.map((x) => `${x.route} (${x.findings[0].what})`).slice(0, 2).join('; ')}`);
          if (runTests) {
            const report = await p.runTests();
            r.caughtByTests = Boolean(report && report.exitCode !== 0);
            if (r.caughtByTests) r.detail.push('tests failed');
          }
          r.verdict = r.caughtByDiff || r.caughtByTests ? 'caught' : 'not caught';
        }
      } finally {
        writeFileSync(file, original);
        rmSync(marker(root), { force: true });
      }
      results.push(r);
    }
  } finally {
    rmSync(dirOf(root), { recursive: true, force: true });
    await p.restartApp();
    p.pauseWatch(false);
  }
  const gaps = results.filter((r) => r.verdict === 'not caught');
  record(root, 'mutation', { mutants: results.length, caught: results.filter((r) => r.verdict === 'caught').length, gaps: gaps.map((g) => `${g.file}:${g.line} ${g.operator}`) });
  return { files: files.length, results, gaps: gaps.length, tests: Boolean(runTests), recovered: restored };
}
