import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir } from '../shared/project-config.js';

/**
 * The evidence ledger: one JSON line per thing backlens checked (a behavior diff, a measurement, a
 * hook decision), in .backlens/evidence.jsonl (mode 600). `backlens report` turns it into a
 * before -> after summary for a pull request. Routes, counts, verdicts and timings only: no
 * headers, values or response bodies.
 */

const MAX_READ_LINES = 5000;

export const ledgerFile = (root) => join(projectDir(root), 'evidence.jsonl');

/** Appends one record; never throws (evidence is best effort, the check itself already ran). */
export function record(root, kind, data) {
  try {
    const file = ledgerFile(root);
    mkdirSync(projectDir(root), { recursive: true });
    const fresh = !existsSync(file);
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), kind, ...data })}\n`, { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
  } catch {}
}

/** Records since `since` (ms), oldest first. Bad lines are skipped. */
export function readLedger(root, since = 0) {
  let text = '';
  try {
    text = readFileSync(ledgerFile(root), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n').slice(-MAX_READ_LINES)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.at >= since) out.push(r);
    } catch {}
  }
  return out;
}
