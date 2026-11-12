'use strict';
/**
 * The index advisor. Asks Postgres how it would run each distinct SELECT, never running it: plain
 * EXPLAIN with GENERIC_PLAN (Postgres 16+) needs no parameter values. When a table is read row by
 * row while filtering on columns that no index starts with, the dashboard suggests the index.
 *
 * It also creates or drops the suggested index when the user asks in the dashboard: one internal
 * request to the app, with the private token. Only an index on named columns can be created or
 * dropped, built here from checked names, never from SQL text; the plan check only re-explains a
 * statement this process already explained.
 */

const { storage } = require('./context.cjs');
const { post } = require('./transport.cjs');

const MAX_EXPLAINS = 200;
let pool = null;
let off = false;
const explained = new Set();

/** The app's first pg Pool: the advisor asks through the app's own connection, never its own. */
function usePool(p) {
  if (!pool) pool = p;
}

function columnsCompared(filter) {
  const cols = [];
  const re = /(?:^|[\s(])(?:"?\w+"?\.)?"?([a-z_][\w]*)"?\s*(?:=|= ANY)\s*(?:\$\d+|'|\d|ANY)/gi;
  let m;
  while ((m = re.exec(filter))) if (!cols.includes(m[1])) cols.push(m[1]);
  return cols;
}

/** 'reviews.updated_at DESC' -> { table: 'reviews', name: 'updated_at', desc: true } */
function sortKey(key) {
  const m = String(key).match(/^(?:"?(\w+)"?\.)?"?([a-z_]\w*)"?(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i);
  return m ? { table: m[1] || null, name: m[2], desc: /desc/i.test(m[3] || '') } : null;
}

// A sort above the scan (ORDER BY … LIMIT) is worth putting in the index after the filter
// columns: Postgres then reads rows already in order and stops at the limit.
function seqScans(node, out = [], sort = []) {
  if (!node) return out;
  if (/Sort$/.test(node['Node Type']) && Array.isArray(node['Sort Key'])) sort = node['Sort Key'].map(sortKey);
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] && node.Filter) {
    const columns = columnsCompared(node.Filter);
    const alias = node.Alias || node['Relation Name'];
    const order = sort.every((k) => k && (!k.table || k.table === alias)) ? sort.filter((k) => !columns.includes(k.name)) : [];
    if (columns.length) out.push({ table: node['Relation Name'], schema: node.Schema || 'public', columns, sort: order.map(({ name, desc }) => ({ name, desc })), filter: node.Filter });
  }
  const keep = /^(Sort|Incremental Sort|Limit|Gather|Gather Merge|Result)$/.test(node['Node Type']) ? sort : [];
  for (const child of node.Plans || []) seqScans(child, out, keep);
  return out;
}

async function advise(p, text) {
  const prefix = /\$\d/.test(text) ? 'EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ' : 'EXPLAIN (VERBOSE, FORMAT JSON) ';
  let plan;
  try {
    plan = (await p.query(prefix + text)).rows[0]['QUERY PLAN'][0].Plan;
  } catch (err) {
    if (/GENERIC_PLAN/i.test(String(err && err.message))) off = true;
    return;
  }
  for (const scan of seqScans(plan)) {
    const { rows } = await p.query(
      `select c.reltuples::bigint as rows,
              coalesce((select json_agg(a.attname) from pg_index i
                        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                        where i.indrelid = c.oid), '[]'::json) as leading
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relname = $1 and n.nspname = $2`,
      [scan.table, scan.schema],
    );
    if (!rows[0]) continue;
    const leading = rows[0].leading || [];
    if (scan.columns.some((col) => leading.includes(col))) continue;
    // How many different values each filter column holds (from ANALYZE; negative is a share of
    // the rows). An index on a column with a handful of values rarely beats reading the table.
    let distinct = {};
    try {
      const st = await p.query('select attname, n_distinct from pg_stats where schemaname = $1 and tablename = $2 and attname = any($3)', [scan.schema, scan.table, scan.columns]);
      distinct = Object.fromEntries(st.rows.map((r) => [r.attname, Number(r.n_distinct)]));
    } catch {}
    post('/advice', { sql: text, table: scan.table, schema: scan.schema, columns: scan.columns, sort: scan.sort, rows: Math.max(0, Number(rows[0].rows)), distinct });
  }
}

/** Explains a statement once, later and outside the request, so recording never slows the app's answer. */
function maybeAdvise(text) {
  if (!pool || off || explained.has(text) || explained.size >= MAX_EXPLAINS) return;
  if (!/^\s*(select|with)\b/i.test(text) || text.includes(';') || /\bpg_(class|index|attribute|namespace)\b/.test(text)) return;
  explained.add(text);
  const p = pool;
  storage.exit(() => setImmediate(() => advise(p, text).catch(() => {})));
}

// ---- creating the suggested index, when the user asks in the dashboard ----------------
const IDENT = /^[a-z_][a-z0-9_$]{0,62}$/i;
const q = (name) => `"${name}"`;

async function indexCommand(body) {
  if (!pool) throw new Error('The app has not used Postgres yet. Use the page once, then try again.');
  const p = pool;
  if (body.action === 'info') {
    const { rows } = await p.query('select current_database() as database, inet_server_addr()::text as address, inet_server_port() as port');
    const o = p.options || {};
    let host = o.host;
    try {
      if (!host && o.connectionString) host = new URL(o.connectionString).hostname;
    } catch {}
    return { database: rows[0].database, host: host || rows[0].address || 'local socket', port: rows[0].port };
  }
  const { schema, table, name } = body;
  const columns = Array.isArray(body.columns) ? body.columns : [];
  if (![schema, table, name].every((x) => typeof x === 'string' && IDENT.test(x)) || !columns.length || columns.length > 8 || !columns.every((c) => c && typeof c.name === 'string' && IDENT.test(c.name))) {
    throw new Error('That is not an index backlens suggested.');
  }
  if (body.action === 'create') {
    const cols = columns.map((c) => `${q(c.name)}${c.desc ? ' DESC' : ''}`).join(', ');
    // CONCURRENTLY builds without blocking writes; it cannot run inside a transaction, so a
    // plain pool query (its own connection, autocommit) is used.
    await p.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${q(name)} ON ${q(schema)}.${q(table)} (${cols})`);
    const { rows } = await p.query(
      `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid join pg_namespace n on n.oid = c.relnamespace where c.relname = $1 and n.nspname = $2`,
      [name, schema],
    );
    if (!rows[0] || !rows[0].valid) throw new Error('Postgres did not finish building the index. Drop it and try again.');
    // Can Postgres use it for the query that showed the issue? On a small table it still
    // prefers reading every row, so the check asks with sequential scans turned off.
    let usable = null;
    if (typeof body.sql === 'string' && explained.has(body.sql)) {
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const prefix = /\$\d/.test(body.sql) ? 'EXPLAIN (GENERIC_PLAN, FORMAT JSON) ' : 'EXPLAIN (FORMAT JSON) ';
        const plan = JSON.stringify((await client.query(prefix + body.sql)).rows[0]['QUERY PLAN']);
        usable = plan.includes(`"Index Name":"${name}"`);
      } catch {
        usable = null;
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    }
    return { created: true, usable };
  }
  if (body.action === 'drop') {
    await p.query(`DROP INDEX CONCURRENTLY IF EXISTS ${q(schema)}.${q(name)}`);
    return { dropped: true };
  }
  throw new Error('Unknown action.');
}

/** Handles POST /__backlens/index from the dashboard (the caller has checked the token). */
function handleCommand(req, res) {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 64 * 1024) req.destroy();
  });
  req.on('end', () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    const reply = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (!body) return reply(400, { error: 'Bad request.' });
    storage.exit(() =>
      indexCommand(body).then(
        (out) => reply(200, out),
        (err) => reply(400, { error: String((err && err.message) || err) }),
      ),
    );
  });
}

module.exports = { usePool, maybeAdvise, handleCommand };
