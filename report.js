import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { summarize } from './analyze.js';

/**
 * The test-mode report. An issue's identity leaves out line numbers, so editing a file above
 * a known issue does not turn it into a new one.
 */
export function stableKey(issue) {
  return [issue.type, issue.route, issue.sql, issue.sites.map((s) => s.replace(/:\d+$/, '')).join(',')].join('|');
}

export function readBaseline(file) {
  if (!existsSync(file)) return new Set();
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return new Set((data.issues ?? []).map((i) => i.key));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

export function writeBaseline(file, issues) {
  const body = {
    note: 'Known issues backlens will not fail the build on. Regenerate with: backlens test --update-baseline -- <your test command>',
    issues: issues.map((i) => ({ key: stableKey(i), title: i.title, route: i.route, sites: i.sites })),
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** Splits issues into new and known, and decides whether the run fails. */
export function judge(traces, known, baseline, { strict = false, advice = [] } = {}) {
  const { routes, issues } = summarize(traces, known, advice);
  const marked = issues.map((i) => ({ ...i, isNew: !baseline.has(stableKey(i)) }));
  const failing = marked.filter((i) => i.isNew && (i.severity === 'warn' || strict));
  return { routes, issues: marked, failing };
}

const c = (code) => (s) => (process.stderr.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c('31');
const yellow = c('33');
const dim = c('2');
const bold = c('1');

export function format({ routes, issues, failing }, traces) {
  const called = routes.filter((r) => r.calls).length;
  const lines = [''];
  const calls = (kind) => traces.reduce((n, t) => n + t.spans.filter((x) => x.kind === kind).length, 0);
  lines.push(`${bold('backlens')}  ${traces.length} requests (${calls('db')} queries, ${calls('redis')} redis, ${calls('http')} http out), ${called} of ${routes.length} routes called, ${issues.length} issue${issues.length === 1 ? '' : 's'}${failing.length ? `, ${red(`${failing.length} new`)}` : ''}`);
  if (!traces.length) {
    lines.push(yellow('  no requests reached backlens. Do the tests call the app over HTTP (supertest, fetch)?'));
    return lines.join('\n');
  }
  lines.push('');
  for (const i of issues) {
    const tag = i.isNew ? (i.severity === 'warn' ? red('new   ') : yellow('new   ')) : dim('known ');
    const kind = i.severity === 'warn' ? '' : dim(' (hint)');
    lines.push(`  ${tag}${i.title}${kind}  ${dim(`${i.route}, ${i.seen}/${i.of} requests`)}`);
    lines.push(`        ${dim(i.sites.join(' → '))}`);
  }
  if (issues.length) lines.push('');
  const untested = routes.filter((r) => !r.calls).length;
  if (untested) lines.push(dim(`  ${untested} route${untested === 1 ? '' : 's'} never called by these tests`));
  return lines.join('\n');
}
