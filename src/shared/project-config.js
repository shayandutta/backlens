import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The project's .backlens folder: config, AI settings, snapshots, fix backups, the running session. */
export const projectDir = (root) => join(root, '.backlens');
const file = (root) => join(projectDir(root), 'config.json');

/** Which package.json scripts start the app and run the tests, or null before setup. */
export function loadConfig(root) {
  try {
    const c = JSON.parse(readFileSync(file(root), 'utf8'));
    return { app: typeof c.app === 'string' ? c.app : null, test: typeof c.test === 'string' ? c.test : null, autoRestart: Boolean(c.autoRestart) };
  } catch {
    return null;
  }
}

/** config.json is shareable; snapshots, AI usage, history and fix backups are personal. */
export const IGNORE = '# Personal: snapshots, AI usage, fix backups and the running session. config.json can be committed.\nsnapshots/\nai/\nai.json\nai-usage.jsonl\nai-history.jsonl\nai-fixtures.json\nsession.json\n';

export function ensureIgnore(root) {
  const ignore = join(projectDir(root), '.gitignore');
  let current = '';
  try {
    current = readFileSync(ignore, 'utf8');
  } catch {}
  if (!current.includes('session.json')) writeFileSync(ignore, IGNORE);
}

export function saveConfig(root, config) {
  mkdirSync(projectDir(root), { recursive: true });
  ensureIgnore(root);
  writeFileSync(file(root), `${JSON.stringify(config, null, 2)}\n`);
}
