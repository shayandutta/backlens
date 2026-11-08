/**
 * Turns raw traces into routes and issues. Pure functions, so they are easy to test.
 *
 * Three checks, each kept narrow so it is right when it fires:
 *  - repeat:     the same query with the same values twice in one request.
 *  - n-plus-one: the same query with different values three or more times in one request.
 *  - serial:     calls from one function awaited back to back, which could run together if
 *                they do not depend on each other. A hint, since backlens cannot see that.
 */

// Numbers, uuids, long hex, and long mixed-case tokens. Lowercase slugs like backend-engineering-vol-2 stay.
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[\w-]*\d)(?=[\w-]*[A-Z])(?=[\w-]*[a-z])[\w-]{16,})$/;

/** /v1/lessons/3f8a…/start becomes /v1/lessons/:id/start. */
export function routeOf(method, url, template) {
  if (template) return `${method} ${template}`;
  const path = url
    .split('/')
    .map((s) => (ID_SEGMENT.test(s) ? ':id' : s))
    .join('/');
  return `${method} ${path || '/'}`;
}

/** Strips literals, so queries that differ only in inlined values group together. */
export function normalizeSql(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/(?<![\w$])\d+(\.\d+)?\b/g, '?')
    .replace(/\bin\s*\((?:\s*(?:\?|\$\d+)\s*,?)+\)/gi, 'in (…)')
    .replace(/\s+/g, ' ')
    .trim();
}

const READS = new Set(['GET', 'HGET', 'HGETALL', 'MGET', 'EXISTS', 'SMEMBERS', 'LRANGE', 'ZRANGE']);
const REDIS_READ = new Set([...READS, 'HMGET', 'SISMEMBER', 'ZSCORE', 'TTL', 'PTTL', 'STRLEN', 'HLEN', 'SCARD', 'ZCARD', 'LLEN', 'TYPE', 'SCAN']);

/** Only calls that read can be moved to run together: writes keep their order on purpose. */
export function isRead(span) {
  if (span.kind === 'db') return /^\s*(select|with)\b/i.test(span.name) && !/\b(insert|update|delete|merge)\b/i.test(span.name);
  if (span.kind === 'redis') return REDIS_READ.has(span.name.split(' ')[0]);
  if (span.kind === 'http') return /^(GET|HEAD) /.test(span.name);
  return false;
}
const where = (span) => (span.frames && span.frames[0]) || null;

/** Where two calls' code paths part: the first frame that differs in each. */
function splitSites(a, b) {
  const fa = a.frames || [];
  const fb = b.frames || [];
  for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
    const x = fa[i];
    const y = fb[i];
    if (x.file !== y.file || x.line !== y.line || x.fn !== y.fn) return [x, y];
  }
  return [fa[0] || null, fb[0] || null];
}

/**
 * The function two calls were awaited in: a frame both stacks share (same function, same callers
 * above it) at different lines. signup → take → eval twice is awaited in signup; mine() awaiting a
 * query directly and then this.eligible() (which queries) is awaited in mine.
 */
function awaitedIn(a, b) {
  const fa = a.frames || [];
  const fb = b.frames || [];
  const same = (x, y) => x.fn === y.fn && x.file === y.file;
  const sameAbove = (i, j) => {
    const n = Math.min(fa.length - i - 1, fb.length - j - 1);
    for (let k = 1; k <= n; k++) if (!same(fa[i + k], fb[j + k]) || fa[i + k].line !== fb[j + k].line) return false;
    return true;
  };
  for (let i = 0; i < fa.length; i++) {
    for (let j = 0; j < fb.length; j++) {
      if (same(fa[i], fb[j]) && fa[i].line !== fb[j].line && sameAbove(i, j)) return fa[i];
    }
  }
  return null;
}

const at = (f) => (f ? `${f.file}:${f.line}` : 'unknown');
const sum = (list) => list.reduce((n, s) => n + s.duration, 0);
const r1 = (n) => Math.round(n * 10) / 10;

/** Issues found in one trace. */
export function checkTrace(trace) {
  const issues = [];
  // A line that many different statements pass through is a wrapper (a pool.query or logging
  // helper), not where the app made the call: skip it so locations point at the real code.
  const raw = trace.spans.filter((s) => s.kind === 'db' || s.kind === 'redis' || s.kind === 'http');
  const throughLine = new Map();
  for (const s of raw) {
    const f = s.frames && s.frames[0];
    if (!f) continue;
    const key = `${f.file}:${f.line}`;
    if (!throughLine.has(key)) throughLine.set(key, new Set());
    throughLine.get(key).add(normalizeSql(s.name));
  }
  const wrappers = new Set([...throughLine].filter(([, names]) => names.size >= 2).map(([key]) => key));
  const strip = (frames) => {
    const out = [...(frames || [])];
    while (out.length > 1 && wrappers.has(`${out[0].file}:${out[0].line}`)) out.shift();
    return out;
  };
  const io = raw.map((s) => ({ ...s, frames: strip(s.frames) }));
  const db = io.filter((s) => s.kind === 'db');

  // Same statement, grouped.
  const bySql = new Map();
  for (const s of db) {
    const key = normalizeSql(s.name);
    if (!bySql.has(key)) bySql.set(key, []);
    bySql.get(key).push(s);
  }
  const covered = new Set();
  const repeats = [];
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
  for (const s of io.filter((x) => x.kind === 'redis' && READS.has(x.name.split(' ')[0]) && x.params)) {
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

  // Calls from one function that started only after the previous one finished.
  const ordered = io.filter((s) => !covered.has(s) && where(s)).sort((a, b) => a.start - b.start);
  let run = [];
  const flush = () => {
    if (run.length >= 2 && sum(run) >= 0.3 && fnOfRun) {
      const f = fnOfRun;
      issues.push({
        type: 'serial',
        severity: 'hint',
        title: `${run.length} calls in ${f.fn} wait for each other`,
        fix: 'If none of them needs the result of another, start them together with Promise.all.',
        sql: run.map((s) => s.name.slice(0, 80)).join('\n'),
        sites: [...new Set(run.map((s) => at((s.frames || []).find((x) => x.fn === f.fn && x.file === f.file))))],
        frames: [run[0].frames],
        cost: r1(sum(run) - Math.max(...run.map((s) => s.duration))),
      });
    }
    run = [];
  };
  let fnOfRun = null;
  // A call that takes a value an earlier call returned depends on it: they cannot run together.
  const dependsOn = (later, earlier) => {
    if (!later.took || !earlier.gave) return false;
    const gave = new Set(earlier.gave);
    return later.took.some((v) => gave.has(v));
  };
  for (const s of ordered) {
    if (!isRead(s)) {
      // A write between calls pins their order: nothing on either side may move across it.
      flush();
      fnOfRun = null;
      continue;
    }
    const prev = run[run.length - 1];
    const shared = prev ? awaitedIn(prev, s) : null;
    // Same kind only: a cache read then a database load is cache-aside, and the load depends on the miss.
    const sameFn = Boolean(shared) && prev.kind === s.kind && (!fnOfRun || (shared.fn === fnOfRun.fn && shared.file === fnOfRun.file));
    if (sameFn && run.length === 1) fnOfRun = shared;
    const afterPrev = prev && s.start >= prev.start + prev.duration - 0.05;
    const overlapsAny = ordered.some((o) => o !== s && o.start < s.start + s.duration && s.start < o.start + o.duration);
    const dependent = run.some((r) => dependsOn(s, r));
    if (prev && sameFn && afterPrev && !overlapsAny && !dependent) run.push(s);
    else {
      flush();
      fnOfRun = null;
      if (!overlapsAny) run = [s];
    }
  }
  flush();

  return issues;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Routes and issues across every trace kept. */
/**
 * fixed: issue key -> when a fix for it was kept. Such an issue is hidden until a request after
 * that moment shows it again.
 */
export function summarize(traces, known = [], advice = [], fixed = new Map()) {
  const routes = new Map();
  const issues = new Map();
  for (const trace of traces) {
    const route = routeOf(trace.method, trace.url, trace.template);
    if (!routes.has(route)) routes.set(route, { route, calls: 0, durations: [], queries: 0, redis: 0, http: 0, errors: 0, issueKeys: new Set(), last: 0 });
    const r = routes.get(route);
    r.calls++;
    r.durations.push(trace.duration);
    r.queries += trace.spans.filter((s) => s.kind === 'db').length;
    r.redis += trace.spans.filter((s) => s.kind === 'redis').length;
    r.http += trace.spans.filter((s) => s.kind === 'http').length;
    if (trace.status >= 500) r.errors++;
    r.last = Math.max(r.last, trace.at);

    for (const issue of checkTrace(trace)) {
      const key = `${issue.type}|${route}|${issue.sql}|${issue.sites.join(',')}`;
      r.issueKeys.add(key);
      if (!issues.has(key)) issues.set(key, { ...issue, key, route, seen: 0, example: trace.id, costTotal: 0 });
      const agg = issues.get(key);
      agg.seen++;
      agg.costTotal += issue.cost;
      agg.example = trace.id;
      agg.lastAt = Math.max(agg.lastAt || 0, trace.at || 0);
    }
  }
  // Index advice: one issue per route that ran the query. Its location skips wrapper lines that
  // many different statements pass through, as checkTrace does.
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
    const big = a.rows >= 1000;
    const name = `${a.table}_${a.columns.join('_')}_idx`.slice(0, 63);
    for (const [route, info] of perRoute) {
      const key = `index|${route}|${sql}|${a.table}`;
      routes.get(route)?.issueKeys.add(key);
      issues.set(key, {
        type: 'index',
        severity: big ? 'warn' : 'hint',
        title: `No index for ${a.table} filtered by ${a.columns.join(', ')}`,
        fix: `Postgres reads every row of ${a.table} (${a.rows.toLocaleString('en')} now${big ? '' : ', fine while small, slow as it grows'}). Add: CREATE INDEX CONCURRENTLY ${name} ON ${a.schema === 'public' ? '' : `${a.schema}.`}${a.table} (${a.columns.join(', ')});`,
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

  // Routes the app registered but nobody has called yet.
  for (const route of known) {
    if (!routes.has(route)) routes.set(route, { route, calls: 0, durations: [], queries: 0, redis: 0, http: 0, errors: 0, issueKeys: new Set(), last: 0 });
  }
  for (const [key, issue] of issues) {
    if (fixed.has(key) && fixed.get(key) >= (issue.lastAt || 0)) {
      issues.delete(key);
      routes.get(issue.route)?.issueKeys.delete(key);
    }
  }
  const routeList = [...routes.values()]
    .map((r) => ({
      route: r.route,
      calls: r.calls,
      p50: percentile(r.durations, 50),
      p95: percentile(r.durations, 95),
      queries: r.calls ? r1(r.queries / r.calls) : 0,
      redis: r.calls ? r1(r.redis / r.calls) : 0,
      http: r.calls ? r1(r.http / r.calls) : 0,
      errors: r.errors,
      issues: r.issueKeys.size,
      last: r.last,
    }))
    .sort((a, b) => b.last - a.last || a.route.localeCompare(b.route));
  const issueList = [...issues.values()]
    .map((i) => ({ ...i, of: routes.get(i.route).calls, cost: r1(i.costTotal / i.seen) }))
    .sort((a, b) => (a.severity === b.severity ? b.seen * b.cost - a.seen * a.cost : a.severity === 'warn' ? -1 : 1));
  return { routes: routeList, issues: issueList };
}

// ---- the map ------------------------------------------------------------------------

const WRITE_SQL = /^\s*(insert|update|delete|merge)\b/i;
const REDIS_READS = new Set(['GET', 'MGET', 'HGET', 'HGETALL', 'HMGET', 'EXISTS', 'SMEMBERS', 'SISMEMBER', 'LRANGE', 'ZRANGE', 'ZSCORE', 'TTL', 'SCAN', 'KEYS']);

/** Tables a statement touches, and whether it writes them. */
export function tablesOf(sql) {
  const tables = new Set();
  const re = /\b(?:from|join|into|update)\s+(?:only\s+)?"?([a-z_][\w$]*)"?(?:\s*\.\s*"?([a-z_][\w$]*)"?)?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = (m[2] || m[1]).toLowerCase();
    if (!['select', 'set', 'values', 'lateral', 'unnest', 'generate_series', 'json_each', 'jsonb_each'].includes(name)) tables.add(name);
  }
  return { tables: [...tables], write: WRITE_SQL.test(sql) };
}

/** rl:route:lesson-read:user:{id} → rl:route:*. Keys with values in them group by their first two parts. */
export function keyGroup(key) {
  const parts = String(key).split(':');
  if (parts.length <= 2) return key;
  return `${parts.slice(0, 2).join(':')}:*`;
}

function targetsOf(span) {
  if (span.kind === 'db') {
    const { tables, write } = tablesOf(span.name);
    return tables.map((t) => ({ id: `pg:${t}`, service: 'postgres', label: t, write }));
  }
  if (span.kind === 'redis') {
    const [cmd, ...rest] = span.name.split(' ');
    const key = rest.join(' ').replace(/^token bucket /, '');
    if (!key) return [];
    return [{ id: `redis:${keyGroup(key)}`, service: 'redis', label: keyGroup(key), write: !REDIS_READS.has(cmd) }];
  }
  if (span.kind === 'http') {
    const host = (span.name.split(' ')[1] || '').split('/')[0];
    return host ? [{ id: `http:${host}`, service: 'http', label: host, write: false }] : [];
  }
  return [];
}

/** Routes, the things they touch, and the wires between them, from recorded traffic only. */
export function mapOf(traces, issues = []) {
  const routes = new Map();
  const nodes = new Map();
  const edges = new Map();
  for (const trace of traces) {
    const route = routeOf(trace.method, trace.url, trace.template);
    if (!routes.has(route)) routes.set(route, { id: route, calls: 0, durations: [], errors: 0 });
    const r = routes.get(route);
    r.calls++;
    r.durations.push(trace.duration);
    if (trace.status >= 500) r.errors++;
    const seenHere = new Set();
    for (const span of trace.spans) {
      for (const t of targetsOf(span)) {
        if (!nodes.has(t.id)) nodes.set(t.id, { id: t.id, service: t.service, label: t.label, calls: 0, reads: 0, writes: 0, ms: 0, routes: new Set() });
        const n = nodes.get(t.id);
        n.calls++;
        n.ms += span.duration;
        if (t.write) n.writes++;
        else n.reads++;
        n.routes.add(route);
        const key = `${route}→${t.id}`;
        if (!edges.has(key)) edges.set(key, { from: route, to: t.id, calls: 0, ms: 0, requests: 0, issues: 0 });
        const e = edges.get(key);
        e.calls++;
        e.ms += span.duration;
        if (!seenHere.has(key)) {
          seenHere.add(key);
          e.requests++;
        }
      }
    }
  }

  // Put each issue on the wires it is about.
  // Red wires mean a real problem; hints (could run in parallel) stay neutral.
  for (const issue of issues.filter((i) => i.severity === 'warn')) {
    const targets = new Set();
    for (const line of String(issue.sql || '').split('\n')) {
      if (/^(select|insert|update|delete|with)\b/i.test(line.trim())) for (const t of tablesOf(line).tables) targets.add(`pg:${t}`);
      else {
        const [, key] = line.split(' ');
        if (key) targets.add(`redis:${keyGroup(key)}`);
      }
    }
    for (const to of targets) {
      const e = edges.get(`${issue.route}→${to}`);
      if (e) e.issues++;
    }
  }

  const round = (n) => Math.round(n * 10) / 10;
  return {
    routes: [...routes.values()]
      .map((r) => ({ id: r.id, calls: r.calls, p50: percentile(r.durations, 50), errors: r.errors }))
      .sort((a, b) => a.id.split(' ')[1].localeCompare(b.id.split(' ')[1]) || a.id.localeCompare(b.id)),
    nodes: [...nodes.values()]
      .map((n) => ({ id: n.id, service: n.service, label: n.label, calls: n.calls, reads: n.reads, writes: n.writes, ms: round(n.ms), routes: n.routes.size }))
      .sort((a, b) => a.service.localeCompare(b.service) || b.calls - a.calls),
    edges: [...edges.values()].map((e) => {
      const r = routes.get(e.from);
      return { ...e, ms: round(e.ms), perRequest: round(e.calls / r.calls), share: round((e.requests / r.calls) * 100) };
    }),
  };
}
