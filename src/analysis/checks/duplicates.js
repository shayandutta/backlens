import { r1 } from '../../shared/stats.js';
import { at, chainOf, loopSite, splitSites, where } from '../frames.js';
import { normalizeSql, REDIS_REPEATABLE_READS, tablesOf } from '../statements.js';

/**
 * Two checks that both look for one statement run several times in a request:
 *  - n-plus-one: the same query with different values three or more times.
 *  - repeat:     the same query (or Redis read) with the same values twice or more.
 *
 * Returns the issues, n-plus-one first, and the spans they cover (which the serial check skips).
 */

const sum = (list) => list.reduce((n, s) => n + s.duration, 0);
const located = (spans) => spans.every((s) => s.frames && s.frames.length);
// Two copies of one call that run at the same time are suspicious: an app awaits one before the
// other far more often than it fires both at once, and a call recorded twice looks exactly like this.
const overlapping = (spans) => spans.some((a, i) => spans.slice(i + 1).some((b) => a.start < b.start + b.duration && b.start < a.start + a.duration));

export function findDuplicates(io) {
  const issues = [];
  const covered = new Set();
  const repeats = [];

  // Same statement, grouped.
  const bySql = new Map();
  for (const s of io.filter((x) => x.kind === 'db')) {
    const key = normalizeSql(s.name);
    if (!bySql.has(key)) bySql.set(key, []);
    bySql.get(key).push(s);
  }
  for (const [sql, list] of bySql) {
    const byValues = new Map();
    for (const s of list) {
      if (!s.params) continue;
      if (!byValues.has(s.params)) byValues.set(s.params, []);
      byValues.get(s.params).push(s);
    }
    for (const same of byValues.values()) {
      if (same.length < 2) continue;
      same.forEach((s) => covered.add(s));
      repeats.push({ label: sql, same });
    }
    const distinct = new Set(list.map((s) => s.params));
    if (list.length >= 3 && distinct.size >= 3) {
      list.forEach((s) => covered.add(s));
      issues.push({
        type: 'n-plus-one',
        severity: 'warn',
        title: `N+1: one query ran ${list.length} times with different values`,
        fix: (() => {
          const loop = loopSite(list[0].frames);
          return loop
            ? `Fetch them in one query (WHERE id IN (…) or a join). The calls come from ${loop.fn || 'a function'} (${at(loop)}), which likely loops over the items: batch the lookup there.`
            : 'Fetch them in one query (WHERE id IN (…) or a join) instead of one per item.';
        })(),
        sql,
        sites: [...new Set(list.map((s) => at(where(s))))],
        frames: [list[0].frames],
        chain: chainOf(list[0].frames),
        cost: r1(sum(list) - Math.max(...list.map((s) => s.duration))),
        evidence: { calls: list.length, distinct: distinct.size, sites: new Set(list.map((s) => at(where(s)))).size, located: located(list) },
      });
    }
  }

  // Redis reads of the same key with the same arguments.
  const reads = new Map();
  for (const s of io.filter((x) => x.kind === 'redis' && REDIS_REPEATABLE_READS.has(x.name.split(' ')[0]) && x.params)) {
    const key = `${s.name}|${s.params}`;
    if (!reads.has(key)) reads.set(key, []);
    reads.get(key).push(s);
  }
  for (const same of reads.values()) {
    if (same.length < 2) continue;
    same.forEach((s) => covered.add(s));
    repeats.push({ label: same[0].name, same });
  }

  // Repeats that part ways at the same two places come from one cause: report them together.
  const byCause = new Map();
  for (const r of repeats) {
    const sites = splitSites(r.same[0], r.same[1]).map(at);
    const key = sites.join('|');
    if (!byCause.has(key)) byCause.set(key, { sites, items: [] });
    byCause.get(key).items.push(r);
  }
  // A write to a table between two reads of it means the second read may see new data.
  const writes = io.filter((x) => x.kind === 'db' && tablesOf(x.name).write);
  const writeBetween = (same) => {
    const tables = new Set(tablesOf(same[0].name).tables);
    const from = Math.min(...same.map((s) => s.start));
    const to = Math.max(...same.map((s) => s.start));
    return writes.some((w) => w.start > from && w.start < to && tablesOf(w.name).tables.some((t) => tables.has(t)));
  };
  for (const { sites, items } of byCause.values()) {
    const calls = items.reduce((n, r) => n + r.same.length - 1, 0);
    const spans = items.flatMap((r) => r.same);
    issues.push({
      type: 'repeat',
      severity: 'warn',
      title: calls === 1 ? 'The same call is made twice in one request' : `${calls} calls are made twice in one request`,
      fix: 'The second path asks for data the first already has. Pass the first result along instead of fetching it again.',
      sql: items.map((r) => r.label).join('\n'),
      sites: [...new Set(sites)],
      frames: [items[0].same[0].frames, items[0].same[1].frames],
      chains: [chainOf(items[0].same[0].frames), chainOf(items[0].same[1].frames)],
      cost: r1(items.reduce((n, r) => n + sum(r.same.slice(1)), 0)),
      evidence: { located: located(spans), overlapping: items.some((r) => overlapping(r.same)), writeBetween: items.some((r) => writeBetween(r.same)) },
    });
  }

  return { issues, covered };
}
