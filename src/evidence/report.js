import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findSessions } from '../mcp/session.js';
import { compareTimings } from '../shared/compare.js';
import { readLedger } from './ledger.js';

/**
 * `backlens report`: what backlens checked while the work was done, as Markdown for a pull
 * request. Everything comes from .backlens/evidence.jsonl, written as the checks ran: no number
 * here is computed after the fact from anything but those records.
 */

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ms = (x) => (x == null ? '-' : `${x} ms`);

/** The Markdown report for ledger records (oldest first). Pure. */
export function reportMarkdown(records, { hours = null } = {}) {
  const diffs = records.filter((r) => r.kind === 'diff');
  const hooks = records.filter((r) => r.kind === 'hook');
  const accepts = records.filter((r) => r.kind === 'accept');
  const measures = records.filter((r) => r.kind === 'measure' && r.now);
  const out = ['## backlens evidence', ''];
  if (!records.length) return [...out, '_Nothing recorded: no behavior diff or measurement ran in this period._'].join('\n');
  out.push(`_${plural(diffs.length, 'behavior check')}, ${plural(measures.length, 'measurement')}${hours ? ` in the last ${hours} h` : ''}. Replays of the running app, recorded as they ran._`, '');

  // Behavior: where it ended, what was caught on the way, what was accepted as intended.
  out.push('### Behavior');
  const last = diffs.at(-1);
  if (last) {
    out.push(last.broken ? `- **Last check: ${plural(last.broken, 'break')} still open** on ${plural(last.checked, 'route')}:` : `- Last check: ${plural(last.checked, 'route')} replayed, no breaks.`);
    if (last.broken)
      for (const r of last.results.filter((x) => x.findings.some((f) => f.kind === 'broken')))
        out.push(`  - \`${r.route}\`: ${r.findings.filter((f) => f.kind === 'broken').map((f) => f.what).join('; ')}`);
  } else out.push('- No behavior check ran.');
  const blocked = hooks.filter((h) => h.blocked).length;
  const caught = diffs.filter((d) => d.broken).flatMap((d) => d.results.filter((r) => r.findings.some((f) => f.kind === 'broken')).map((r) => r.route));
  if (caught.length) out.push(`- Breaks caught during the work: ${[...new Set(caught)].map((r) => `\`${r}\``).join(', ')}${blocked ? ` (the agent was sent back ${plural(blocked, 'time')})` : ''}${last && !last.broken ? '; all fixed or accepted by the last check' : ''}.`);
  const acceptedRoutes = [...new Set(accepts.flatMap((a) => a.routes || []))];
  if (acceptedRoutes.length) {
    out.push(`- Intended changes accepted: ${acceptedRoutes.length}`);
    // What each accepted route changed, from the last diff that showed it before the accept.
    for (const route of acceptedRoutes.slice(0, 10)) {
      // What the diff just before the (last) accept of this route showed.
      const acceptedAt = Math.max(...accepts.filter((a) => (a.routes || []).includes(route)).map((a) => a.at));
      const seen = [...diffs].reverse().find((d) => d.at <= acceptedAt && d.results.some((r) => r.route === route));
      const what = seen ? seen.results.find((r) => r.route === route).findings.map((f) => f.what).join('; ') : 'baseline retaken';
      out.push(`  - \`${route}\`: ${what}`);
    }
  }
  out.push('');

  // Measurements: per request, the first measurement against the last.
  const byKey = new Map();
  for (const m of measures) {
    const key = `${m.route}${m.as ? ` (as ${m.as})` : ''}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  const pairs = [...byKey.entries()].filter(([, list]) => list.length >= 2);
  if (pairs.length) {
    out.push('### Measured before → after (local replays)', '', '| Route | Before | After | Time | Queries |', '|---|---|---|---|---|');
    for (const [key, list] of pairs) {
      const a = list[0].now;
      const b = list.at(-1).now;
      const c = compareTimings(a, b);
      const verdict = !c ? '-' : c.verdict === 'same' ? 'within noise' : `${c.verdict} (${c.pct > 0 ? '+' : ''}${c.pct}%)`;
      out.push(`| \`${key}\` | ${ms(a.ms)} (${a.lo}–${a.hi}) | ${ms(b.ms)} (${b.lo}–${b.hi}) | ${verdict} | ${a.queries} → ${b.queries} |`);
    }
    out.push('', '_Local replays on the developer\'s machine (warm medians on fresh app runs, recording on), not production latency; p25–p75 in brackets. A time change counts only when it is at least 1 ms and the ranges do not overlap._');
  }
  return out.join('\n');
}

export function runReport({ args, root }) {
  const session = findSessions(root)[0];
  const base = session ? session.root : root;
  if (!existsSync(join(base, '.backlens'))) {
    process.stderr.write('No .backlens folder here: run backlens in the app folder first.\n');
    process.exit(1);
  }
  const hours = args.has('--all') ? null : Number(args.flag('--since')) || 24;
  const records = readLedger(base, hours ? Date.now() - hours * 3600 * 1000 : 0);
  process.stdout.write(`${reportMarkdown(records, { hours })}\n`);
}
