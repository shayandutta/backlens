/**
 * App memory: what backlens has learned about this app across sessions, for an agent to read
 * before it changes something. Built from what is already kept (the evidence ledger, the behavior
 * baseline, recorded traffic) plus notes agents and people leave (.backlens/memory.json). Pure:
 * the dashboard hands it the data.
 *
 * Without a route or file: an overview. With a route: its code, tables, numbers, issues and its
 * history (breaks caught, changes accepted, measurements, races). With a file: the routes that run
 * it and what went wrong around it before.
 */

const MAX_HISTORY = 8;

const day = (at) => new Date(at).toISOString().slice(0, 10);

/** Past events from the ledger, as { at, route, file, kind, text }. */
export function historyOf(ledger) {
  const out = [];
  for (const r of ledger) {
    if (r.kind === 'diff' && Array.isArray(r.results))
      for (const x of r.results) {
        const broken = (x.findings || []).filter((f) => f.kind === 'broken');
        if (broken.length) out.push({ at: r.at, route: x.route, kind: 'broke', text: broken.map((f) => f.what).join('; ') });
      }
    if (r.kind === 'accept' && Array.isArray(r.routes)) for (const route of r.routes) out.push({ at: r.at, route, kind: 'accepted', text: 'a behavior change was accepted as intended' });
    if (r.kind === 'measure' && r.previous && r.now) out.push({ at: r.at, route: r.route, kind: 'measured', text: `${r.previous.queries} -> ${r.now.queries} queries, ${r.previous.ms} -> ${r.now.ms} ms${r.change && r.change.verdict ? ` (${r.change.verdict})` : ''}` });
    if (r.kind === 'mutation' && Array.isArray(r.gaps))
      for (const g of r.gaps) {
        const [where, op] = String(g).split(' ');
        out.push({ at: r.at, file: where.replace(/:\d+$/, ''), kind: 'gap', text: `${op || 'a guard change'} at ${where} was caught by neither the diff nor the tests` });
      }
    if (r.kind === 'race' && Array.isArray(r.races)) for (const x of r.races) out.push({ at: r.at, route: x.route, kind: 'race', text: (x.what || []).join('; ') });
    if (r.kind === 'trial' && r.route) out.push({ at: r.at, route: r.route, kind: 'trial', text: r.winner ? `fix "${r.winner}" won of ${r.tried} tried${r.kept ? ' and was kept' : ''}` : `${r.tried} fixes tried, none better` });
  }
  return out;
}

const line = (h) => `  ${day(h.at)} ${h.kind}: ${h.route && h.file ? `${h.route} ` : ''}${h.text}`;

/**
 * The text an agent reads. `routes`: dashboard route stats; `uses`: route -> { files, tables }
 * (from the baseline and traffic); `issues`: current issues; `notes`: [{ id, at, text, route, file }].
 */
export function recallText({ route = null, file = null, routes = [], uses = new Map(), issues = [], ledger = [], notes = [] }) {
  const history = historyOf(ledger);
  const lines = [];
  if (route) {
    const r = routes.find((x) => x.route === route);
    const u = uses.get(route) || { files: [], tables: [] };
    if (!r && !u.files.length && !history.some((h) => h.route === route)) return `backlens knows nothing about ${route} yet: use the page once so a request is recorded.`;
    lines.push(`${route}`);
    if (r) lines.push(`  traffic: ${r.calls} calls, p50 ${r.p50} ms, ${r.queries} queries/request, ${r.redis} redis, ${r.http} http, ${r.errors} 5xx`);
    if (u.files.length) lines.push(`  code it runs: ${u.files.slice(0, 8).join(', ')}${u.files.length > 8 ? ` (+${u.files.length - 8})` : ''}`);
    if (u.tables.length) {
      lines.push(`  tables: ${u.tables.join(', ')}`);
      const shared = [...uses].filter(([other, x]) => other !== route && x.tables.some((t) => u.tables.includes(t))).map(([other]) => other);
      if (shared.length) lines.push(`  shares data with: ${shared.slice(0, 6).join(', ')}${shared.length > 6 ? ` (+${shared.length - 6})` : ''}`);
    }
    const mine = issues.filter((i) => i.route === route);
    if (mine.length) lines.push('  open issues:', ...mine.map((i) => `    ${i.title}${i.confidence ? ` [${i.confidence.level || i.confidence}]` : ''}${i.sites && i.sites.length ? ` (${i.sites[0]})` : ''}`));
    const past = history.filter((h) => h.route === route || (h.file && u.files.includes(h.file)));
    if (past.length) lines.push('  history:', ...past.slice(-MAX_HISTORY).map((h) => `  ${line(h)}`));
    const said = notes.filter((n) => n.route === route || (n.file && u.files.includes(n.file)));
    if (said.length) lines.push('  notes:', ...said.map((n) => `    [${n.id}] ${n.text}`));
    return lines.join('\n');
  }
  if (file) {
    const runBy = [...uses].filter(([, x]) => x.files.includes(file)).map(([r]) => r);
    const past = history.filter((h) => h.file === file || runBy.includes(h.route));
    const said = notes.filter((n) => n.file === file || runBy.includes(n.route));
    if (!runBy.length && !past.length && !said.length) return `No recorded request ran ${file}, and nothing is noted about it: a change there reaches routes backlens cannot name, so the gate checks all of them.`;
    lines.push(file);
    lines.push(runBy.length ? `  routes that run it: ${runBy.join(', ')}` : '  no recorded request ran it');
    const mine = issues.filter((i) => (i.sites || []).some((s) => String(s).startsWith(`${file}:`)));
    if (mine.length) lines.push('  open issues here:', ...mine.map((i) => `    ${i.route}: ${i.title}${i.confidence ? ` [${i.confidence.level || i.confidence}]` : ''}`));
    if (past.length) lines.push('  history:', ...past.slice(-MAX_HISTORY).map((h) => `  ${line(h)}`));
    if (said.length) lines.push('  notes:', ...said.map((n) => `    [${n.id}] ${n.text}`));
    return lines.join('\n');
  }
  const called = routes.filter((r) => r.calls);
  const tables = new Map();
  for (const [, u] of uses) for (const t of u.tables) tables.set(t, (tables.get(t) || 0) + 1);
  lines.push(`What backlens knows about this app: ${called.length} routes with traffic, ${uses.size} with recorded code paths, ${issues.length} open issues.`);
  if (tables.size) lines.push(`Most shared tables: ${[...tables].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} (${n} routes)`).join(', ')}`);
  const bad = history.filter((h) => ['broke', 'gap', 'race'].includes(h.kind));
  if (bad.length) lines.push('', 'Past failures and gaps (newest last):', ...bad.slice(-MAX_HISTORY).map(line));
  const good = history.filter((h) => h.kind === 'measured' || h.kind === 'trial');
  if (good.length) lines.push('', 'Recent measurements and fixes:', ...good.slice(-5).map(line));
  if (notes.length) lines.push('', 'Notes:', ...notes.slice(-12).map((n) => `  [${n.id}] ${n.route || n.file ? `${n.route || n.file}: ` : ''}${n.text}`));
  lines.push('', 'Ask with a route ("POST /v1/orders") or a file (src/orders/orders.service.ts) before changing it.');
  return lines.join('\n');
}
