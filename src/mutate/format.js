/** The lab's report as text, for the terminal and agents. */
export function mutationText(r) {
  if (r.error) return r.error;
  const lines = [`Mutation lab: ${r.results.length} guard change${r.results.length === 1 ? '' : 's'} in ${r.files} files requests ran through, checked with the behavior diff${r.tests ? ' and the tests' : ''}.`];
  if (r.recovered) lines.push(`(Put back ${r.recovered}, left mutated by an interrupted run.)`);
  lines.push('');
  for (const x of r.results) {
    const mark = x.verdict === 'not caught' ? '✗ NOT CAUGHT' : x.verdict === 'caught' ? '✓ caught' : '- invalid';
    lines.push(`${mark.padEnd(14)} ${x.file}:${x.line}  ${x.describe}${x.detail.length ? `  (${x.detail.join('; ')})` : ''}`);
  }
  lines.push('');
  lines.push(r.gaps ? `${r.gaps} change${r.gaps === 1 ? '' : 's'} nothing noticed: an agent could make ${r.gaps === 1 ? 'it' : 'them'} and get no signal. Add a test (or a recorded request that exercises the guard) for each.` : 'Every guard change was noticed.');
  return lines.join('\n');
}
