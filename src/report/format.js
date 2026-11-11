import { ttyBold as bold, ttyDim as dim, ttyRed as red, ttyYellow as yellow } from '../shared/ansi.js';
import { trafficTotals } from './judge.js';

/** The terminal report printed after `backlens test`. */
export function format({ routes, issues, failing }, traces) {
  const called = routes.filter((r) => r.calls).length;
  const t = trafficTotals(traces);
  const lines = [''];
  lines.push(
    `${bold('backlens')}  ${t.requests} requests (${t.queries} queries, ${t.redis} redis, ${t.http} http out), ${called} of ${routes.length} routes called, ${issues.length} issue${issues.length === 1 ? '' : 's'}${failing.length ? `, ${red(`${failing.length} new`)}` : ''}`,
  );
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
