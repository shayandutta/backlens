/** `backlens doctor` as text, for the terminal and for agents (MCP). */

const MARK = { ok: '✓', untested: '!', shared: '!' };

export function doctorText(d) {
  if (d.error) return d.error;
  const lines = ['Adapters (what the recorder hooked into in the running app):'];
  if (!d.recorderSeen) lines.push('  none reported yet: the app has not started under backlens 0.7+, or has not loaded its libraries yet.');
  for (const a of d.adapters) lines.push(`  ${MARK[a.status] || '?'} ${a.name.padEnd(12)} ${a.version || ''}${a.why ? `  ${a.why}` : ''}`);
  lines.push('', 'Cost of recording (same request, recording on vs off, alternated, timed from outside the app):');
  for (const o of d.overhead) {
    lines.push(`  ${o.route}: ${o.recording.ms} ms with recording, ${o.bare.ms} ms without (+${o.ms} ms${o.pct != null ? `, +${o.pct}%` : ''}; p25-p75 ${o.recording.lo}-${o.recording.hi} vs ${o.bare.lo}-${o.bare.hi})`);
  }
  if (!d.overhead.length && !d.notes.length) lines.push('  not measured');
  for (const n of d.notes) lines.push(`  ${n}`);
  if (d.overhead.length) {
    const ms = d.overhead.map((o) => o.ms);
    const pct = d.overhead.map((o) => o.pct).filter((p) => p != null);
    const range = (xs, unit) => (Math.min(...xs) === Math.max(...xs) ? `${Math.max(...xs)}${unit}` : `${Math.min(...xs)}-${Math.max(...xs)}${unit}`);
    lines.push(
      '',
      `Recording adds ${range(ms, ' ms')}${pct.length ? ` (${range(pct, '%')})` : ''} a request here. Before/after comparisons stay fair, since backlens records both sides; absolute times read about that much higher than the app without backlens. All backlens timings are local replays, not production latency.`,
    );
  }
  const bad = d.adapters.filter((a) => a.status !== 'ok');
  if (bad.length) lines.push('', `Check: ${bad.map((a) => a.name).join(', ')} (see above). Report unexpected results at github.com/shayandutta/backlens/issues.`);
  return lines.join('\n');
}
