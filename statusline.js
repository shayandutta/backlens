#!/usr/bin/env node
/**
 * Claude Code status line wrapper. Claude Code pipes the session's state to the status line command on
 * every update, including how much of the Claude plan's 5-hour and weekly limits is used. backlens keeps
 * those two numbers (and nothing else) so it can show what each prompt used of the plan, then runs the
 * status line the user already had, unchanged.
 *
 * Kept free of other backlens imports: it runs on every status line refresh.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configDir() {
  if (process.env.BACKLENS_HOME) return process.env.BACKLENS_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'backlens');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'backlens');
}

export const limitsFile = () => join(configDir(), 'limits.jsonl');
const stateFile = () => join(configDir(), 'statusline.json');
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const settingsFile = () => join(claudeDir(), 'settings.json');

const HEARTBEAT = 5 * 60e3;

function readJSON(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Saves the plan limits from one status line update: on a change, and every 5 minutes so gaps are visible. */
export function recordLimits(input, now = Date.now()) {
  const rl = input && input.rate_limits;
  if (!rl || (!rl.five_hour && !rl.seven_day)) return false;
  const pick = (w) => (w && typeof w.used_percentage === 'number' ? [w.used_percentage, w.resets_at || null] : [null, null]);
  const state = readJSON(stateFile(), {});
  const last = state.last;
  // Every open Claude Code session reports the limits from its own last API reply, so an idle one sends
  // older, lower numbers. Use within a window only goes up: keep the highest seen.
  const latest = (value, resets, prev, prevResets) => (last && value !== null && resets === prevResets && prev !== null && prev > value ? prev : value);
  let [five, fiveResets] = pick(rl.five_hour);
  let [seven, sevenResets] = pick(rl.seven_day);
  five = latest(five, fiveResets, last && last.five, last && last.fiveResets);
  seven = latest(seven, sevenResets, last && last.seven, last && last.sevenResets);
  const sample = { at: now, five, fiveResets, seven, sevenResets };
  const same = last && last.five === five && last.seven === seven && last.fiveResets === fiveResets && last.sevenResets === sevenResets;
  if (same && now - last.at < HEARTBEAT) return false;
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  appendFileSync(limitsFile(), JSON.stringify(sample) + '\n', { mode: 0o600 });
  writeState({ ...state, last: sample });
  return true;
}

function writeState(state) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = stateFile() + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, stateFile());
}

/** Reads the update from stdin, records it, then hands the same input to the user's own status line. */
export async function runStatusline() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks);
  try {
    recordLimits(JSON.parse(raw.toString('utf8')));
  } catch {
    // A status line must never break: bad input just isn't recorded.
  }
  const wrap = readJSON(stateFile(), {}).wrap;
  if (!wrap) return;
  const child = spawn(wrap, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(raw);
  await new Promise((done) => child.on('close', (code) => done((process.exitCode = code || 0))));
}

const OURS = /statusline\.js"?\s*$/;

/** Points Claude Code's status line at backlens, keeping the one already set up. Returns what changed. */
export function install() {
  const file = settingsFile();
  const settings = readJSON(file, existsSync(file) ? null : {});
  if (!settings) throw new Error(`Could not read ${file} as JSON; nothing was changed.`);
  const current = settings.statusLine;
  if (current && OURS.test(current.command || '')) return { already: true, wrap: readJSON(stateFile(), {}).wrap || null };
  const self = fileURLToPath(import.meta.url);
  const command = `"${process.execPath}" "${self}"`;
  writeState({ ...readJSON(stateFile(), {}), wrap: current && current.type === 'command' ? current.command : null, previous: current || null });
  settings.statusLine = { ...(current || {}), type: 'command', command };
  const tmp = file + '.backlens.tmp';
  mkdirSync(claudeDir(), { recursive: true });
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, file);
  return { already: false, command, wrap: current ? current.command : null, inNpxCache: self.includes(`${join('_npx', '')}`) };
}

/** Puts back the status line that was there before install. */
export function uninstall() {
  const file = settingsFile();
  const settings = readJSON(file, null);
  const state = readJSON(stateFile(), {});
  if (!settings || !settings.statusLine || !OURS.test(settings.statusLine.command || '')) return { changed: false };
  if (state.previous) settings.statusLine = state.previous;
  else delete settings.statusLine;
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  writeState({ ...state, wrap: null, previous: null });
  return { changed: true, restored: state.previous ? state.previous.command : null };
}

/** Plan limit samples, oldest first. */
export function readLimits() {
  let text;
  try {
    text = readFileSync(limitsFile(), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  const high = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    let s;
    try {
      s = JSON.parse(line);
    } catch {
      continue;
    }
    // Same rule as when recording, for logs written before it: within a window, never lower than before.
    for (const key of ['five', 'seven']) {
      const h = high[key];
      if (s[key] !== null && h && h.resets === s[key + 'Resets'] && h.value > s[key]) s[key] = h.value;
      if (s[key] !== null) high[key] = { resets: s[key + 'Resets'], value: s[key] };
    }
    out.push(s);
  }
  return out;
}

/**
 * Percentage points of a limit used between two times, from the samples. Null when the samples don't
 * cover both ends (status line not running, or a gap longer than the heartbeat).
 */
export function limitUsed(samples, start, end, key) {
  const resetsKey = key + 'Resets';
  const grace = 15e3;
  const before = samples.findLast((s) => s.at <= start && s[key] !== null);
  const after = samples.findLast((s) => s.at <= end + grace && s[key] !== null);
  if (!before || !after || start - before.at > HEARTBEAT + 60e3 || after.at < before.at) return null;
  if (end - after.at > HEARTBEAT + 60e3) return null;
  if (before[resetsKey] === after[resetsKey]) return Math.max(0, after[key] - before[key]);
  // The window reset during the prompt: what was used before the reset, plus everything after it.
  const lastOld = samples.findLast((s) => s.at <= end + grace && s[resetsKey] === before[resetsKey] && s[key] !== null);
  return Math.max(0, (lastOld ? lastOld[key] : before[key]) - before[key]) + after[key];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runStatusline();
