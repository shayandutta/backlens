import { execFileSync } from 'node:child_process';
import { tablesOf } from '../analysis/index.js';

/**
 * Impact: which routes a change can reach, so the gate replays those (first, or only) instead of
 * all of them. From what requests really did: each recorded call carries the code lines behind it,
 * so a route "uses" the files on those stacks and the tables its queries touch.
 *
 *   changed file seen in a route's calls     -> that route
 *   a query from a changed file on a table   -> every route that touches the table (shared data)
 *   a changed file no request ran through    -> all routes: its reach is unknown (a new helper,
 *                                               a module file, a handler with no calls)
 *   config, dependencies, schema, migrations -> all routes
 *   only docs and tests                      -> none
 *
 * Unknown always widens to all routes: the gate never skips a route it cannot rule out.
 */

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TESTY = /(^|\/)(test|tests|__tests__|spec|e2e)\/|\.(test|spec|e2e-spec)\.[cm]?[jt]sx?$/;
const EVERYTHING = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|\.env[^/]*|nest-cli\.json|[^/]*\.config\.[cm]?[jt]s|schema\.prisma|docker-compose[^/]*\.ya?ml)$|(^|\/)(migrations?|drizzle|prisma)\//;
const IGNORED = /\.(md|mdx|txt|png|jpe?g|gif|svg|ico|css|scss|html)$|(^|\/)(docs?|\.github|\.claude|\.cursor|\.codex|\.backlens)\//;

/** Files changed against HEAD, plus untracked ones, relative to the root; null outside git. */
export function changedFiles(root) {
  try {
    const opts = { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
    // --relative: paths from the root, even when the root is a folder inside a bigger repo.
    const tracked = execFileSync('git', ['diff', 'HEAD', '--name-only', '--relative', '--', '.'], opts);
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', '.'], opts);
    return [...new Set(`${tracked}\n${untracked}`.split('\n').map((l) => l.trim()).filter(Boolean))];
  } catch {
    return null;
  }
}

/** Files and tables a set of traces used: { files: Set, tables: Set, tablesByFile: Map<file, Set> }. */
export function usageOf(traces) {
  const files = new Set();
  const tables = new Set();
  const tablesByFile = new Map();
  for (const t of traces) {
    for (const s of t.spans || []) {
      const fs = (s.frames || []).map((f) => f.file).filter((f) => f && !f.includes('node_modules'));
      for (const f of fs) files.add(f);
      if (s.kind !== 'db') continue;
      for (const table of tablesOf(s.name).tables) {
        tables.add(table);
        for (const f of fs) {
          if (!tablesByFile.has(f)) tablesByFile.set(f, new Set());
          tablesByFile.get(f).add(table);
        }
      }
    }
  }
  return { files, tables, tablesByFile };
}

/**
 * The routes a change can reach. `routes`: [{ route, files: [], tables: [] }]; `tablesByFile`:
 * Map file -> tables its queries touch. Returns { scope: 'none' | 'some' | 'all', routes: [], why: [] }.
 */
export function impactOf({ changed, routes, tablesByFile = new Map() }) {
  const all = routes.map((r) => r.route);
  if (!changed) return { scope: 'all', routes: all, why: ['not a git repository: every route is checked'] };
  const config = changed.filter((f) => EVERYTHING.test(f));
  if (config.length) return { scope: 'all', routes: all, why: [`${config.slice(0, 2).join(', ')} can affect every route`] };
  const code = changed.filter((f) => SOURCE.test(f) && !TESTY.test(f) && !IGNORED.test(f));
  if (!code.length) return { scope: 'none', routes: [], why: [changed.length ? 'only docs, tests or assets changed' : 'no file changed'] };
  const known = new Set(routes.flatMap((r) => r.files || []));
  const unseen = code.filter((f) => !known.has(f));
  if (unseen.length) return { scope: 'all', routes: all, why: [`${unseen.slice(0, 2).join(', ')}${unseen.length > 2 ? ` and ${unseen.length - 2} more` : ''} never ran in a recorded request, so ${unseen.length === 1 ? 'its' : 'their'} reach is unknown`] };
  const hit = new Set();
  const why = [];
  for (const r of routes) {
    const via = code.filter((f) => (r.files || []).includes(f));
    if (via.length) {
      hit.add(r.route);
      why.push(`${r.route}: runs ${via[0]}`);
    }
  }
  const tables = new Set(code.flatMap((f) => [...(tablesByFile.get(f) || [])]));
  for (const r of routes) {
    if (hit.has(r.route)) continue;
    const shared = (r.tables || []).filter((t) => tables.has(t));
    if (shared.length) {
      hit.add(r.route);
      why.push(`${r.route}: reads or writes ${shared[0]}, which the changed code touches`);
    }
  }
  return { scope: 'some', routes: all.filter((r) => hit.has(r)), why };
}
