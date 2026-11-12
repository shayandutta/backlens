/** Plain-text views for agents: issues, requests as waterfalls. Short lines, no colour. */

export const ms = (v) => (v == null ? '-' : `${v} ms`);
export const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
export const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
export const at = (f) => (f ? `${f.file}:${f.line}` : '');
export const indent = (text, pad = '    ') => String(text).split('\n').map((l) => pad + l).join('\n');

/** What an issue costs, said as the estimate it is: medians of recorded traffic, not a measurement. */
export const costText = (i) => (i.type === 'serial' ? `up to ~${i.cost} ms saved per request if run together (estimate; measure to confirm)` : `~${i.cost} ms of repeated work per request (median)`);

export function issueText(i, n) {
  const lines = [`${n}. [${i.severity}] ${i.title}`, `   route: ${i.route}   seen in ${i.seen} of ${i.of} requests${i.cost ? `   ${costText(i)}` : ''}`];
  if (i.confidence) {
    const c = i.confidence;
    lines.push(`   confidence: ${c.level}${c.why.length ? ` (${c.why.join('; ')})` : ''}`);
    if (c.against.length) lines.push(`   doubts: ${c.against.join('; ')}`);
  }
  if (i.sites && i.sites.length) lines.push(`   code: ${i.sites.join(' -> ')}`);
  if (i.chain && i.chain.length > 1) lines.push(`   path: ${i.chain.join(' -> ')}`);
  if (i.chains && i.chains.some((c) => c.length > 1)) i.chains.forEach((c, k) => lines.push(`   path ${k + 1}: ${c.join(' -> ')}`));
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
