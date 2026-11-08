import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The user's Claude API key, pasted in the dashboard. It is kept outside every project, in the
 * user's config folder, readable by the user only, so it can never be committed with the code.
 * ANTHROPIC_API_KEY in the environment wins over the saved key. The key never goes back to the
 * browser: the dashboard only sees its last four characters.
 */

export function configDir() {
  if (process.env.BACKLENS_HOME) return process.env.BACKLENS_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'backlens');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'backlens');
}

const file = () => join(configDir(), 'credentials.json');

/** A loose shape check, so a pasted sentence or a key from another service is caught early. */
export function looksLikeKey(key) {
  return typeof key === 'string' && /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key);
}

export function savedKey() {
  try {
    const key = JSON.parse(readFileSync(file(), 'utf8')).anthropicApiKey;
    return looksLikeKey(key) ? key : null;
  } catch {
    return null;
  }
}

export function saveKey(key) {
  if (!looksLikeKey(key)) throw new Error('That does not look like a Claude API key. It starts with sk-ant-.');
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file(), `${JSON.stringify({ anthropicApiKey: key }, null, 2)}\n`, { mode: 0o600 });
  // mode only applies when the file is created; tighten an existing one too.
  try {
    chmodSync(file(), 0o600);
  } catch {}
}

export function removeKey() {
  rmSync(file(), { force: true });
}

/** The key to use and where it came from: the environment first, then the saved one. */
export function currentKey() {
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: 'env' };
  const key = savedKey();
  return key ? { key, source: 'saved' } : { key: null, source: null };
}

export const lastFour = (key) => (key ? key.slice(-4) : '');
