import { r1 } from '../../shared/stats.js';
import { at, splitSites, where } from '../frames.js';
import { normalizeSql, REDIS_REPEATABLE_READS } from '../statements.js';

/**
 * Two checks that both look for one statement run several times in a request:
 *  - n-plus-one: the same query with different values three or more times.
 *  - repeat:     the same query (or Redis read) with the same values twice or more.
 *
 * Returns the issues, n-plus-one first, and the spans they cover (which the serial check skips).
 */

const sum = (list) => list.reduce((n, s) => n + s.duration, 0);

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
        fix: 'Fetch them in one query (WHERE id IN (…) or a join) instead of one per item.',
        sql,
        sites: [...new Set(list.map((s) => at(where(s))))],
        frames: [list[0].frames],
        cost: r1(sum(list) - Math.max(...list.map((s) => s.duration))),
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
  for (const { sites, items } of byCause.values()) {
    const calls = items.reduce((n, r) => n + r.same.length - 1, 0);
    issues.push({
      type: 'repeat',
      severity: 'warn',
      title: calls === 1 ? 'The same call is made twice in one request' : `${calls} calls are made twice in one request`,
      fix: 'The second path asks for data the first already has. Pass the first result along instead of fetching it again.',
      sql: items.map((r) => r.label).join('\n'),
      sites: [...new Set(sites)],
      frames: [items[0].same[0].frames, items[0].same[1].frames],
      cost: r1(items.reduce((n, r) => n + sum(r.same.slice(1)), 0)),
    });
  }

  return { issues, covered };
}
