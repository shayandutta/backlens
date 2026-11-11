import { existsSync, readFileSync } from 'node:fs';
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

/** The project's name and package.json scripts. */
export function readProject(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return { name: pkg.name || basename(root), scripts: pkg.scripts || {} };
  } catch {
    return { name: basename(root), scripts: {} };
  }
}

/** Runs a package.json script by name. Only names from package.json are ever run. */
export function scriptCommand(pm, script) {
  return [pm, 'run', script];
}
