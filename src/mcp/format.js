/** Plain-text views for agents: issues, requests as waterfalls. Short lines, no colour. */

export const ms = (v) => (v == null ? '-' : `${v} ms`);
export const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
export const at = (f) => (f ? `${f.file}:${f.line}` : '');
export const indent = (text, pad = '    ') => String(text).split('\n').map((l) => pad + l).join('\n');

export function issueText(i, n) {
  const lines = [`${n}. [${i.severity}] ${i.title}`, `   route: ${i.route}   seen in ${i.seen} of ${i.of} requests${i.cost ? `   ~${i.cost} ms lost each time` : ''}`];
  if (i.sites && i.sites.length) lines.push(`   code: ${i.sites.join(' -> ')}`);
  if (i.sql) lines.push(`   calls:\n${indent(i.sql, '     ')}`);
  if (i.fix) lines.push(`   fix: ${i.fix}`);
  lines.push(`   example request: ${i.example}`);
  return lines.join('\n');
}

export function spanText(s) {
  const where = s.frames && s.frames.length ? `  <- ${s.frames.slice(0, 3).map(at).join(' <- ')}` : '';
  const extra = [s.status != null ? `status ${s.status}` : '', s.rows != null ? `${plural(s.rows, 'row')}` : '', s.hit != null ? (s.hit ? 'hit' : 'miss') : '', s.error ? 'ERROR' : '']
    .filter(Boolean)
    .join(', ');
  return `  +${String(s.start).padStart(7)} ms  ${String(s.duration).padStart(7)} ms  ${s.kind.padEnd(5)} ${s.name}${extra ? `  (${extra})` : ''}${where}`;
}

export function traceText(trace, issues) {
  const count = (kind) => trace.spans.filter((s) => s.kind === kind).length;
  const out = [
    `${trace.method} ${trace.url}  (route ${trace.route})`,
    `status ${trace.status}, ${ms(trace.duration)}, ${plural(count('db'), 'query')}, ${count('redis')} redis, ${count('http')} http out`,
    '',
    '  start        took        kind  call  <- code',
    ...trace.spans.map(spanText),
  ];
  if (issues && issues.length) out.push('', 'Issues in this request:', ...issues.map((i, n) => `${n + 1}. ${i.title}${i.sites && i.sites.length ? `  (${i.sites.join(' -> ')})` : ''}`));
  return out.join('\n');
}
