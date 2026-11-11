import { routeOf } from './routes.js';
import { normalizeSql } from './statements.js';

/**
 * Turns the recorder's index advice (a SELECT that reads a whole table to filter it, from
 * EXPLAIN) into issues: one per route that ran the statement. Its location skips wrapper lines
 * that many different statements pass through, as checkTrace does.
 */

const at = (f) => (f ? `${f.file}:${f.line}` : 'unknown');

/** At this size a full-table read is a real problem; below it, a hint for later. */
const BIG_TABLE_ROWS = 1000;

export function indexIssues(traces, advice) {
  const through = new Map();
  for (const t of traces) {
    for (const sp of t.spans) {
      const f = sp.frames && sp.frames[0];
      if (!f) continue;
      const k = `${f.file}:${f.line}`;
      if (!through.has(k)) through.set(k, new Set());
      through.get(k).add(normalizeSql(sp.name));
    }
  }
  const appFrame = (frames) => (frames || []).find((f) => !(through.get(`${f.file}:${f.line}`)?.size >= 2)) || (frames || [])[0];

  const issues = [];
  for (const a of advice) {
    const sql = normalizeSql(a.sql.replace(/\s+/g, ' ').trim().slice(0, 600));
    const perRoute = new Map();
    for (const trace of traces) {
      const span = trace.spans.find((s) => s.kind === 'db' && normalizeSql(s.name) === sql);
      if (!span) continue;
      const route = routeOf(trace.method, trace.url, trace.template);
      if (!perRoute.has(route)) perRoute.set(route, { seen: 0, example: trace.id, span, lastAt: 0 });
      perRoute.get(route).seen++;
      perRoute.get(route).lastAt = Math.max(perRoute.get(route).lastAt, trace.at || 0);
    }
    const big = a.rows >= BIG_TABLE_ROWS;
    // Filter columns first, then the ORDER BY columns, so rows come out already sorted.
    const cols = [...a.columns.map((c) => ({ name: c, desc: false })), ...(Array.isArray(a.sort) ? a.sort : []).filter((c) => c && typeof c.name === 'string')];
    const name = `${a.table}_${cols.map((c) => c.name).join('_')}_idx`.slice(0, 63);
    const colText = cols.map((c) => `${c.name}${c.desc ? ' DESC' : ''}`).join(', ');
    for (const [route, info] of perRoute) {
      const key = `index|${route}|${sql}|${a.table}`;
      issues.push({
        type: 'index',
        severity: big ? 'warn' : 'hint',
        title: `No index for ${a.table} filtered by ${a.columns.join(', ')}`,
        fix: `Postgres reads every row of ${a.table} (${a.rows.toLocaleString('en')} now${big ? '' : ', fine while small, slow as it grows'}). Add: CREATE INDEX CONCURRENTLY ${name} ON ${a.schema === 'public' ? '' : `${a.schema}.`}${a.table} (${colText});`,
        index: { schema: a.schema || 'public', table: a.table, name, columns: cols, sql: a.sql },
        sql,
        sites: appFrame(info.span.frames) ? [at(appFrame(info.span.frames))] : [],
        frames: [info.span.frames],
        cost: 0,
        key,
        route,
        seen: info.seen,
        example: info.example,
        lastAt: info.lastAt,
        costTotal: 0,
      });
    }
  }
  return issues;
}
