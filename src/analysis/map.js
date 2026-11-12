import { percentile, r1 } from '../shared/stats.js';
import { routeOf } from './routes.js';
import { keyGroup, REDIS_MAP_READS, tablesOf } from './statements.js';

/** The things one call touches: Postgres tables, a Redis key group, or an outside host. */
function targetsOf(span) {
  if (span.kind === 'db') {
    const { tables, write } = tablesOf(span.name);
    return tables.map((t) => ({ id: `pg:${t}`, service: 'postgres', label: t, write }));
  }
  if (span.kind === 'redis') {
    const [cmd, ...rest] = span.name.split(' ');
    const key = rest.join(' ').replace(/^token bucket /, '');
    if (!key) return [];
    return [{ id: `redis:${keyGroup(key)}`, service: 'redis', label: keyGroup(key), write: !REDIS_MAP_READS.has(cmd) }];
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

  return {
    routes: [...routes.values()]
      .map((r) => ({ id: r.id, calls: r.calls, p50: percentile(r.durations, 50), errors: r.errors }))
      .sort((a, b) => a.id.split(' ')[1].localeCompare(b.id.split(' ')[1]) || a.id.localeCompare(b.id)),
    nodes: [...nodes.values()]
      .map((n) => ({ id: n.id, service: n.service, label: n.label, calls: n.calls, reads: n.reads, writes: n.writes, ms: r1(n.ms), routes: n.routes.size }))
      .sort((a, b) => a.service.localeCompare(b.service) || b.calls - a.calls),
    edges: [...edges.values()].map((e) => {
      const r = routes.get(e.from);
      return { ...e, ms: r1(e.ms), perRequest: r1(e.calls / r.calls), share: r1((e.requests / r.calls) * 100) };
    }),
  };
}
