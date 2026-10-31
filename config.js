import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

/** The package manager this project uses, from the nearest lockfile up the tree. */
export function packageManager(root) {
  let dir = root;
  for (;;) {
    for (const [file, pm] of LOCKFILES) if (existsSync(join(dir, file))) return pm;
    const up = dirname(dir);
    if (up === dir) return 'npm';
    dir = up;
  }
}

export function readProject(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return { name: pkg.name || basename(root), scripts: pkg.scripts || {} };
  } catch {
    return { name: basename(root), scripts: {} };
  }
}

const file = (root) => join(root, '.backlens', 'config.json');

export function loadConfig(root) {
  try {
    const c = JSON.parse(readFileSync(file(root), 'utf8'));
    return { app: typeof c.app === 'string' ? c.app : null, test: typeof c.test === 'string' ? c.test : null, autoRestart: Boolean(c.autoRestart) };
  } catch {
    return null;
  }
}

/** config.json is shareable; snapshots, AI usage, history and fix backups are personal. */
export const IGNORE = '# Personal: snapshots, AI usage and fix backups. config.json can be committed.\nsnapshots/\nai/\nai.json\nai-usage.jsonl\nai-history.jsonl\nai-fixtures.json\n';
export function ensureIgnore(root) {
  const ignore = join(root, '.backlens', '.gitignore');
  let current = '';
  try {
    current = readFileSync(ignore, 'utf8');
  } catch {}
  if (!current.includes('ai-usage.jsonl')) writeFileSync(ignore, IGNORE);
}

export function saveConfig(root, config) {
  mkdirSync(join(root, '.backlens'), { recursive: true });
  ensureIgnore(root);
  writeFileSync(file(root), `${JSON.stringify(config, null, 2)}\n`);
}

/** Runs a package.json script by name. Only names from package.json are ever run. */
export function scriptCommand(pm, script) {
  return [pm, 'run', script];
}
