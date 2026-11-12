/** The concurrency probes' report as text, for the terminal and agents. */
export function raceText(r) {
  if (r.error) return r.error;
  const lines = [`Concurrency probes: each write sent ${r.copies} times one after another, then ${r.copies} at once, in rolled-back transactions (nothing kept, no job queued).`, ''];
  for (const x of r.results) {
    if (x.error) {
      lines.push(`${x.route}`, `  ${x.error}`);
      continue;
    }
    if (x.skipped) {
      lines.push(`${x.route}`, `  not probed: ${x.skipped}`);
      continue;
    }
    lines.push(`${x.route}   one after another: ${x.seq.ok} ok, ${x.seq.refused} refused, ${x.seq.failed} 5xx   at once: ${x.conc.ok} ok, ${x.conc.refused} refused, ${x.conc.failed} 5xx`);
    if (!x.findings.length) lines.push(`  ✓ same outcome at once as one after another`);
    for (const f of x.findings) lines.push(`  ${f.kind === 'race' ? '✗' : '~'} [${f.confidence}] ${f.what}`);
    if (x.appRollbacks) lines.push(`  note: the app rolled back its own transaction ${x.appRollbacks} time(s); the probe cannot undo part of a shared transaction, so counts may be off.`);
  }
  lines.push('');
  lines.push(
    r.races
      ? `${r.races} route${r.races === 1 ? '' : 's'} let more through at once than one after another. Make the check and the write one atomic statement (UPDATE ... WHERE stock > 0 RETURNING), use a unique constraint, or lock the row (SELECT ... FOR UPDATE).`
      : 'No race found in these writes.',
  );
  lines.push('The copies run on one shared connection, one statement at a time: interleavings like a real race, but no row locks between them, so code relying on SELECT ... FOR UPDATE is reported as "check", not confirmed.');
  return lines.join('\n');
}
