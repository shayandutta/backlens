/**
 * How sure backlens is about a finding, and why. A pattern in traces is evidence, not proof, so
 * each issue gets one of:
 *
 *   confirmed  strong evidence: act on it
 *   likely     probably real: worth a look
 *   check      suspicious: a human should judge (the data may not mean what it seems)
 *
 * and the reasons, in plain words. Pure: from the issue's evidence and how often it was seen.
 */

export const LEVELS = ['confirmed', 'likely', 'check'];

const share = (i) => (i.of ? i.seen / i.of : 1);
const seenText = (i) => `seen in ${i.seen} of ${i.of} request${i.of === 1 ? '' : 's'}`;

export function confidenceOf(issue) {
  const e = issue.evidence || {};
  const why = [];
  const against = [];
  let level = 'likely';

  if (issue.type === 'repeat') {
    if (e.located === false) against.push('one of the calls has no code location, so backlens may have counted it twice');
    if (e.overlapping) against.push('the copies ran at the same time, which a recording double-count also looks like');
    if (e.writeBetween) against.push('a write to the same table came between them, so the second read may be needed');
    if (issue.of >= 3 && share(issue) < 0.5) against.push(`only ${seenText(issue)}`);
    if (e.located) why.push('every call points at a line of code');
    if (!e.writeBetween) why.push('nothing wrote to that table in between');
    if (against.length) level = 'check';
    else if (issue.seen >= 2 && share(issue) >= 0.5) {
      level = 'confirmed';
      why.push(seenText(issue));
    }
  } else if (issue.type === 'n-plus-one') {
    why.push(`${e.calls ?? '?'} calls with ${e.distinct ?? '?'} different values`);
    if (e.sites === 1) why.push('all from one line of code');
    if (e.located === false) against.push('some calls have no code location');
    if (against.length) level = 'check';
    else if ((e.calls || 0) >= 5 && (e.distinct || 0) >= 5 && e.sites === 1) level = 'confirmed';
  } else if (issue.type === 'serial') {
    // Timing shows the calls waited; it cannot show their order does not matter. Never confirmed.
    if (e.dependencyChecked) why.push('no call used a value an earlier one returned');
    else against.push('backlens could not check whether one call uses the result of another');
    if (e.lock) against.push('one call takes a lock (FOR UPDATE, an advisory lock): the others likely must run after it');
    if (e.fallback) against.push('an earlier call found nothing: the later one may be a fallback that only runs then');
    against.push('order may matter for reasons a trace cannot show; read the code before parallelizing');
    level = e.dependencyChecked && !e.lock && !e.fallback ? 'likely' : 'check';
  } else if (issue.type === 'index') {
    const rows = e.rows;
    if (e.lowCardinality) {
      against.push('the filtered columns hold only a few different values');
      level = 'check';
    } else if ((rows || 0) >= 10000) {
      why.push(`Postgres reads all ${Number(rows).toLocaleString('en')} rows to filter them`);
      level = 'confirmed';
    } else why.push('a full-table read, on a table that is still small');
  }
  return { level, why, against };
}
