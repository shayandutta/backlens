import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * backlens.baseline.json: issues the team already knows about, so CI fails only on new ones.
 * An issue's identity leaves out line numbers, so editing a file above a known issue does not
 * turn it into a new one.
 */

export function stableKey(issue) {
  return [issue.type, issue.route, issue.sql, issue.sites.map((s) => s.replace(/:\d+$/, '')).join(',')].join('|');
}

const entry = (i) => ({ key: stableKey(i), title: i.title, route: i.route, sites: i.sites });

/** The known issue keys. A missing file is an empty baseline; a broken one is an error. */
export function readBaseline(file) {
  if (!existsSync(file)) return new Set();
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return new Set((data.issues ?? []).map((i) => i.key));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** Like readBaseline, but an unreadable file is an empty baseline (the dashboard never fails on it). */
export function readBaselineLenient(file) {
  try {
    return readBaseline(file);
  } catch {
    return new Set();
  }
}

/** Replaces the baseline with these issues (backlens test --update-baseline). */
export function writeBaseline(file, issues) {
  const body = {
    note: 'Known issues backlens will not fail the build on. Regenerate with: backlens test --update-baseline -- <your test command>',
    issues: issues.map(entry),
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** Adds the chosen issues (by stable key) to the baseline, keeping what is there (dashboard "Accept"). */
export function acceptIntoBaseline(file, issues, keys) {
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(file, 'utf8')).issues ?? [];
  } catch {}
  const have = new Set(existing.map((i) => i.key));
  for (const i of issues) {
    const key = stableKey(i);
    if (!keys.includes(key) || have.has(key)) continue;
    existing.push(entry(i));
    have.add(key);
  }
  writeFileSync(file, `${JSON.stringify({ note: 'Known issues backlens will not fail the build on. Commit this file.', issues: existing }, null, 2)}\n`);
}
