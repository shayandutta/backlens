import { MARK } from './compare.js';

/** Plain-text views of a behavior diff, for agents (MCP) and the terminal (CLI). No colour. */

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function diffText(d) {
  if (d.error) return d.error;
  if (d.created) {
    const lines = [`Baseline taken: ${d.captured.length} route${d.captured.length === 1 ? '' : 's'} (${secs(d.ms || 0)}). The next diff compares the app with it.`];
    if (d.skipped && d.skipped.length) lines.push(...d.skipped.map((s) => `  skipped ${s.route}: ${s.why}`));
    return lines.join('\n');
  }
  const head = `${d.checked} route${d.checked === 1 ? '' : 's'} checked in ${secs(d.ms)}${d.restarted ? ' (app restarted first for a fresh run)' : ''}`;
  const lines = [];
  if (d.impact && d.impact.scoped && d.impact.scope === 'none') return `Nothing to check: ${d.impact.why[0] || 'no code that requests run changed'}.`;
  if (!d.results.length) lines.push(`No behavior change: ${head}.`);
  else {
    const counts = [d.broken && `${d.broken} broken`, d.changed && `${d.changed} changed`, d.better && `${d.better} better`].filter(Boolean).join(', ');
    lines.push(`${counts}: ${head}.`, '');
    for (const r of d.results) {
      lines.push(r.route);
      for (const f of r.findings) lines.push(`  ${MARK[f.kind]} ${f.what}`);
    }
    lines.push('');
    if (d.broken) lines.push('✗ items are breaks: fix them, or if the change is intended, accept those routes.');
    else lines.push('If these changes are intended, accept them so the next diff compares with the new behavior.');
  }
  if (d.impact) lines.push('', impactLine(d.impact));
  if (d.note) lines.push('', d.note);
  if (d.unverifiable) lines.push('', `${d.unverifiable} response field${d.unverifiable === 1 ? ' was' : 's were'} null in every baseline response, so only a missing field or a new type shows there, not a changed value. Use data where they are set to cover them.`);
  if (d.skipped && d.skipped.length) lines.push(...(lines.length > 1 ? [''] : []), ...d.skipped.map((s) => `not checked ${s.route}: ${s.why}`));
  return lines.join('\n');
}

/** One line on which routes the change can reach, and so which were checked (first). */
export function impactLine(i) {
  if (i.scope === 'all') return `Reach of the change: all ${i.of} routes (${i.why[0] || 'unknown'}).`;
  if (i.scope === 'none') return `Reach of the change: no route (${i.why[0]}).`;
  const how = i.scoped ? `only those were checked` : `checked first`;
  return `Reach of the change: ${i.routes} of ${i.of} routes, ${how} (${i.why.slice(0, 3).join('; ')}${i.why.length > 3 ? '; ...' : ''}).`;
}

export function acceptText(a) {
  if (a.error) return a.error;
  const lines = [`Accepted ${a.captured.length} route${a.captured.length === 1 ? '' : 's'} as the new baseline (${a.entries} in the baseline).`];
  if (a.skipped && a.skipped.length) lines.push(...a.skipped.map((s) => `  skipped ${s.route}: ${s.why}`));
  return lines.join('\n');
}
