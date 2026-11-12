/** The counterfactual lab's report as text, for the terminal and agents. */
export function trialText(r) {
  if (r.error) return r.error;
  const row = (t) =>
    t.error
      ? `${t.name.padEnd(24)} ✗ ${t.error}`
      : `${t.name.padEnd(24)} ${String(t.queries).padStart(3)} queries  ${String(t.ms).padStart(7)} ms (${t.lo}-${t.hi})  status ${t.status}${t.broken ? `  ✗ broke ${t.broken.join('; ')}` : ''}${t.tests === false ? '  ✗ tests failed' : t.tests ? '  tests ok' : ''}${t.issues && t.issues.length ? `  issues: ${t.issues.length}` : ''}`;
  const lines = [`Counterfactual lab: ${r.trials.length} fix${r.trials.length === 1 ? '' : 'es'} for ${r.route}, each applied, replayed (warm median, p25-p75), diffed on the routes it reaches${r.tests ? ' and tested' : ''}, then put back.`, ''];
  lines.push(row(r.base));
  for (const t of r.trials) lines.push(row(t));
  lines.push('');
  if (r.winner) lines.push(`Best: "${r.winner}": ${r.why}.${r.kept ? ' It is now applied to the code.' : ' Nothing was kept: apply it yourself, or run again with keep: true.'}`);
  else lines.push(`No fix is better than the code as it is: ${r.why}.`);
  lines.push('Times are local replays on this machine (recording on), not production latency.');
  return lines.join('\n');
}
