import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Tokens of the app's own source: what an agent reads when it has to find these issues in the code instead. */
export function sourceTokens(root, limit = 20000) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.backlens', 'test', 'tests', '__tests__', 'generated', 'migrations', 'drizzle', 'public', 'static']);
  const EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.mts', '.cts', '.prisma']);
  let chars = 0;
  let files = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files >= limit) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name));
      } else if (EXT.has(extname(e.name)) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(e.name) && !/(^|[\\/])(vitest|jest|eslint|prettier)\.config/.test(e.name)) {
        try {
          chars += statSync(join(dir, e.name)).size;
          files++;
        } catch {}
      }
    }
  };
  walk(root);
  return { tokens: Math.round(chars / 4), files };
}
