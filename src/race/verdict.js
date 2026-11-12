/**
 * Concurrency probes, judged. The same recorded write is replayed n times one after another, then n
 * times at once, each set in its own rolled-back transaction (one shared by its n copies), starting
 * from the same data. Code that is safe under concurrency ends both ways alike; a check-then-act
 * race lets more copies through at once than one after another.
 *
 * No knowledge of the app is needed: the one-after-another run is the app's own answer to "how
 * many of these may succeed", and the at-once run is checked against it.
 */

const WRITE = /^\s*(insert|update|delete|merge)\b/i;
const LOCKS = /\bfor\s+(no\s+key\s+)?(update|share)\b|pg_advisory|\block\s+table\b|serializable/i;

/** What one set of copies did: successes, failures, rows written, jobs queued. */
export function tally(traces) {
  const out = { copies: traces.length, ok: 0, refused: 0, failed: 0, rows: 0, jobs: 0, statuses: [] };
  for (const t of traces) {
    out.statuses.push(t.status);
    if (t.status < 400) out.ok++;
    else if (t.status < 500) out.refused++;
    else out.failed++;
    for (const s of t.spans || []) {
      if (s.kind === 'db' && WRITE.test(s.name) && !s.error) out.rows += Number(s.rows) || 0;
      if (s.kind === 'job') out.jobs += s.jobs ? s.jobs.length : 1;
    }
  }
  return out;
}

/** Locking the probe cannot exercise (one shared connection holds no locks against itself). */
export const usesLocks = (traces) => traces.some((t) => (t.spans || []).some((s) => s.kind === 'db' && LOCKS.test(s.name)));

/**
 * The findings for one route: [{ kind: 'race' | 'changed', confidence, what }]. `seq` and `conc`
 * are tallies; `locks`: the request takes row locks, which the probe's shared connection does not
 * honour, so a finding is only "check" (the database may well serialize it).
 */
export function raceFindings(seq, conc, { locks = false } = {}) {
  const found = [];
  const confidence = (base) => (locks ? 'check' : base);
  const lockNote = locks ? ' (it takes row locks, which this probe does not exercise: check by hand)' : '';
  if (conc.ok > seq.ok)
    found.push({
      kind: 'race',
      confidence: confidence('confirmed'),
      what: `${conc.ok} of ${conc.copies} copies succeeded at once, but only ${seq.ok} one after another: a check-then-act race lets extra requests through${lockNote}`,
    });
  if (conc.jobs > seq.jobs) found.push({ kind: 'race', confidence: confidence('confirmed'), what: `queued ${conc.jobs} jobs at once against ${seq.jobs} one after another: duplicate jobs under concurrency${lockNote}` });
  if (conc.ok === seq.ok && conc.rows > seq.rows)
    found.push({ kind: 'race', confidence: confidence('likely'), what: `wrote ${conc.rows} rows at once against ${seq.rows} one after another, with the same number of successes: lost or doubled updates${lockNote}` });
  if (conc.failed > seq.failed) found.push({ kind: 'changed', confidence: 'likely', what: `${conc.failed} of ${conc.copies} copies failed with a 5xx at once (${seq.failed} one after another): an unhandled conflict or deadlock` });
  return found;
}
