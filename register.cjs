'use strict';
/**
 * Loaded inside the app with --require. Records each incoming HTTP request and the Postgres,
 * Redis and fetch calls it makes, with the line of app code behind each call, and sends the
 * finished trace to the backlens dashboard. Query values are never sent: only a hash of them,
 * so two identical questions can be told apart from two different ones.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const Module = require('node:module');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const TARGET = process.env.BACKLENS_URL;
// Stack traces hold real paths, so a project reached through a symlink must be resolved too.
const ROOT = (() => {
  const root = process.env.BACKLENS_ROOT || process.cwd();
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
})();
const SELF = __dirname;
const MAX_SPANS = 300;

if (TARGET && !globalThis.__backlens) {
  globalThis.__backlens = true;
  const storage = new AsyncLocalStorage();
  // The app code that called an ORM operation, for the queries that operation runs later.
  const siteStorage = new AsyncLocalStorage();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

  const now = () => performance.now();
  const round = (n) => Math.round(n * 100) / 100;

  /**
   * Bundlers (Next.js with Turbopack or webpack, and other build steps) run code from generated
   * chunks, and some, like Next.js, map stack traces themselves instead of letting Node do it. So
   * backlens reads each chunk's source map itself, cached per file until the file changes.
   */
  const maps = new Map();
  function sourceMapOf(file) {
    if (!/\.[cm]?js$/.test(file)) return null;
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
    const hit = maps.get(file);
    if (hit && hit.mtime === mtime) return hit.map;
    let map = null;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const url = text.slice(-4096).match(/\/\/[#@] sourceMappingURL=(\S+)\s*$/);
      if (url) {
        const payload = url[1].startsWith('data:')
          ? JSON.parse(Buffer.from(url[1].slice(url[1].indexOf(',') + 1), /;base64,/.test(url[1]) ? 'base64' : 'utf8').toString())
          : JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), decodeURIComponent(url[1])), 'utf8'));
        map = new Module.SourceMap(payload);
      }
    } catch {
      map = null;
    }
    if (maps.size > 500) maps.clear();
    maps.set(file, { mtime, map });
    return map;
  }

  /** Where a generated line and column came from, or the input unchanged when there is no map. */
  function original(file, line, column) {
    const map = sourceMapOf(file);
    if (!map) return { file, line };
    try {
      const entry = map.findEntry(line - 1, column - 1);
      if (!entry || !entry.originalSource) return { file, line };
      let source = entry.originalSource;
      if (source.startsWith('file://')) source = decodeURIComponent(new URL(source).pathname);
      else if (!path.isAbsolute(source)) source = path.resolve(path.dirname(file), map.payload.sourceRoot || '', source);
      return { file: source, line: entry.originalLine + 1 };
    } catch {
      return { file, line };
    }
  }

  // Generated ORM clients live in the project but are not the app's code (Prisma's `output`).
  const GENERATED = /[\\/]generated[\\/]prisma[\\/]/;

  /** The first few frames of app code that led to this call, skipping node, node_modules and backlens. */
  function appFrames() {
    // Recording must never break the app: a failure here costs only the location.
    try {
      return collectFrames();
    } catch {
      return [];
    }
  }

  function collectFrames() {
    // Database drivers and ORMs alone can fill the default 10 frames; look deeper for app code.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 80;
    const stack = new Error().stack || '';
    Error.stackTraceLimit = limit;
    const lines = stack.split('\n').slice(2);
    const frames = [];
    for (const line of lines) {
      const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
      if (!m) continue;
      const raw = m[2].replace(/^file:\/\//, '');
      if (raw.startsWith('node:') || raw.includes('node_modules') || raw.startsWith(SELF) || !raw.startsWith('/')) continue;
      // Chunks bundle libraries too, so node_modules is checked again after mapping.
      const at = original(raw, Number(m[3]), Number(m[4]));
      if (at.file.includes('node_modules') || GENERATED.test(at.file) || at.file.startsWith(SELF) || !at.file.startsWith('/')) continue;
      frames.push({ fn: (m[1] || '').replace(/^async /, '') || '(anonymous)', file: path.relative(ROOT, at.file), line: at.line });
      if (frames.length === 8) break;
    }
    return frames;
  }

  /** Keys often carry personal data: rl:login:email:ada@x.com becomes rl:login:email:{email}. */
  function redact(text) {
    return String(text)
      .replace(/[^\s:@]+@[^\s:@]+\.[^\s:@]+/g, '{email}')
      .replace(/(?:::ffff:)?\b\d{1,3}(?:\.\d{1,3}){3}\b/gi, '{ip}')
      .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){4,7}\b/gi, '{ip}')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')
      .replace(/\b\d{6,}\b/g, '{n}');
  }

  function hashValues(values) {
    if (values === undefined) return null;
    try {
      const json = JSON.stringify(values, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      return createHash('sha1').update(json).digest('hex').slice(0, 12);
    } catch {
      return null;
    }
  }

  /**
   * Fingerprints of single values: each parameter a query was given, and the values in the rows it
   * returned. If a later query's parameter matches a value an earlier one returned, it depends on
   * it, and the two cannot run together. Only short hashes are kept, never the values.
   */
  const fp = (v) => createHash('sha1').update(String(v)).digest('hex').slice(0, 10);
  const scalar = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200) || typeof v === 'number' || typeof v === 'bigint';
  function paramPrints(params) {
    if (!Array.isArray(params)) return undefined;
    const out = new Set();
    for (const p of params) for (const v of Array.isArray(p) ? p : [p]) if (scalar(v) && out.size < 60) out.add(fp(v));
    return out.size ? [...out] : undefined;
  }
  function resultPrints(rows) {
    if (!Array.isArray(rows) || !rows.length) return undefined;
    const out = new Set();
    for (const row of rows.slice(0, 200)) {
      if (!row || typeof row !== 'object') continue;
      for (const v of Object.values(row)) if (scalar(v) && out.size < 400) out.add(fp(v));
    }
    return out.size ? [...out] : undefined;
  }

  /** Starts a span for the current request, or returns null outside one. */
  function begin(kind, name, extra) {
    const trace = storage.getStore();
    if (!trace || trace.spans.length >= MAX_SPANS) return null;
    let frames = appFrames();
    // ORMs that batch or schedule queries lose the async stack; fall back to where the app called the ORM.
    if (!frames.length) frames = (siteStorage.getStore() || {}).frames || [];
    const span = { kind, name, start: round(now() - trace.began), duration: 0, frames, ...extra };
    trace.spans.push(span);
    const t0 = now();
    const end = (detail) => {
      span.duration = round(now() - t0);
      if (detail) Object.assign(span, detail);
    };
    end.span = span;
    return end;
  }

  const TOKEN = process.env.BACKLENS_TOKEN || '';
  const SOURCE = process.env.BACKLENS_SOURCE || 'app';

  /** Reports to the dashboard, outside any request so the report itself is never recorded. */
  function post(pathname, payload) {
    const body = JSON.stringify(payload);
    storage.exit(() => {
      const req = http.request(new URL(pathname, TARGET), {
        method: 'POST',
        agent,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-backlens-token': TOKEN },
      });
      req.on('error', () => {});
      req.end(body);
    });
  }

  function send(trace) {
    trace.source = SOURCE;
    post('/ingest', trace);
  }

  // ---- drivers loaded through ESM ----------------------------------------------------
  // Test runners like vitest import pg and ioredis through Node's ESM loader, which never goes
  // through Module._load. Both loaders share one CommonJS cache, so requiring the same packages
  // from the project patches the very copy the app uses. It runs at startup, before the app can
  // create a pool or keep its own reference to an unpatched method, and only for packages the
  // project actually has.
  function patchFromApp() {
    const fromApp = Module.createRequire(path.join(process.cwd(), 'backlens-probe.js'));
    for (const name of ['pg', 'ioredis', 'redis', '@redis/client', '@prisma/client']) {
      try {
        fromApp.resolve(name);
      } catch {
        continue;
      }
      try {
        fromApp(name);
      } catch {}
    }
  }

  // ---- incoming requests -------------------------------------------------------------
  // Framework internals and browser asset fetches, not the app's own routes: Next.js build
  // assets, dev overlay and HMR, Vite dev files, favicons and source maps.
  const INTERNAL = /^\/(?:_next\/|__nextjs|@vite\/|@fs\/|@id\/|node_modules\/|favicon\.ico(?:$|\?))|\.map(?:$|\?)/;

  for (const Server of [http.Server, https.Server]) {
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req, res) {
      if (event === 'listening') {
        try {
          const address = this.address();
          if (address && typeof address === 'object') post('/listening', { port: address.port, pid: process.pid, source: SOURCE });
        } catch {}
      }
      if (event === 'request' && req && res && req.url === '/__backlens/index' && req.method === 'POST' && tokenOk(req.headers['x-backlens-token'])) {
        handleCommand(req, res);
        return true;
      }
      if (event !== 'request' || !req || !res || req.headers['x-backlens'] === 'skip' || INTERNAL.test(req.url || '')) return emit.apply(this, arguments);
      const trace = {
        id: randomUUID(),
        pid: process.pid,
        method: req.method,
        url: (req.url || '/').split('?')[0],
        status: 0,
        at: Date.now(),
        began: now(),
        duration: 0,
        spans: [],
      };
      // The request itself, kept so a fix can be replayed against the changed code. It goes only to
      // the local dashboard's memory: never to disk, never to a model. Bodies over 64 KB are not kept.
      const replayOf = req.headers['x-backlens-replay'];
      if (replayOf) trace.replayOf = String(replayOf);
      const chunks = [];
      let bodySize = 0;
      const reqEmit = req.emit;
      req.emit = function (ev, chunk) {
        if (ev === 'data' && chunk && bodySize <= 65536) {
          bodySize += chunk.length;
          if (bodySize <= 65536) chunks.push(Buffer.from(chunk));
        }
        return reqEmit.apply(this, arguments);
      };
      let sent = false;
      const finish = (aborted) => {
        if (!sent && !replayOf) {
          const headers = { ...req.headers };
          for (const h of ['host', 'content-length', 'connection', 'transfer-encoding', 'x-backlens-replay']) delete headers[h];
          trace.replay = bodySize > 65536 ? { truncated: true } : { method: req.method, url: req.url, headers, body: chunks.length ? Buffer.concat(chunks).toString('base64') : null };
        }
        if (sent) return;
        sent = true;
        // express sets req.route once a route matched; fastify's template arrives via its onRequest hook.
        if (!trace.template && req.route && typeof req.route.path === 'string') trace.template = `${req.baseUrl || ''}${req.route.path}`;
        trace.status = aborted ? 499 : res.statusCode;
        if (aborted) trace.aborted = true;
        trace.duration = round(now() - trace.began);
        delete trace.began;
        // Spans reported after the fact (Prisma's engine) are added late: keep them in time order.
        trace.spans.sort((a, b) => a.start - b.start);
        send(trace);
      };
      res.once('finish', () => finish(false));
      // The browser gave up (navigated away, timed out) before the response was sent.
      res.once('close', () => finish(!res.writableFinished));
      return storage.run(trace, () => emit.apply(this, arguments));
    };
  }

  // ---- Postgres (pg) -----------------------------------------------------------------
  // Pool queries are recorded where the app calls pool.query: the client query inside may
  // run later, in the context of whichever request freed a connection, and is skipped.
  let insidePool = false;

  // ---- index advisor -----------------------------------------------------------------
  // Asks Postgres how it would run each distinct SELECT, never running it: plain EXPLAIN with
  // GENERIC_PLAN (Postgres 16+) needs no parameter values. When a table is read row by row while
  // filtering on columns that no index starts with, the dashboard suggests the index.
  let advisorPool = null;
  let advisorOff = false;
  const explained = new Set();
  const MAX_EXPLAINS = 200;

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

  async function advise(pool, text) {
    const prefix = /\$\d/.test(text) ? 'EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ' : 'EXPLAIN (VERBOSE, FORMAT JSON) ';
    let plan;
    try {
      plan = (await pool.query(prefix + text)).rows[0]['QUERY PLAN'][0].Plan;
    } catch (err) {
      if (/GENERIC_PLAN/i.test(String(err && err.message))) advisorOff = true;
      return;
    }
    for (const scan of seqScans(plan)) {
      const { rows } = await pool.query(
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
      post('/advice', { sql: text, table: scan.table, schema: scan.schema, columns: scan.columns, sort: scan.sort, rows: Math.max(0, Number(rows[0].rows)) });
    }
  }

  // ---- creating the suggested index, when the user asks in the dashboard ----------------
  // The dashboard sends one internal request to the app, with its private token. Only an index
  // on named columns can be created or dropped, built here from checked names, never from SQL
  // text; the plan check only re-explains a statement this process already explained.
  const IDENT = /^[a-z_][a-z0-9_$]{0,62}$/i;
  const q = (name) => `"${name}"`;

  function tokenOk(value) {
    if (!TOKEN || typeof value !== 'string' || value.length !== TOKEN.length) return false;
    return require('node:crypto').timingSafeEqual(Buffer.from(value), Buffer.from(TOKEN));
  }

  async function indexCommand(body) {
    if (!advisorPool) throw new Error('The app has not used Postgres yet. Use the page once, then try again.');
    const pool = advisorPool;
    if (body.action === 'info') {
      const { rows } = await pool.query('select current_database() as database, inet_server_addr()::text as address, inet_server_port() as port');
      const o = pool.options || {};
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
      await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${q(name)} ON ${q(schema)}.${q(table)} (${cols})`);
      const { rows } = await pool.query(
        `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid join pg_namespace n on n.oid = c.relnamespace where c.relname = $1 and n.nspname = $2`,
        [name, schema],
      );
      if (!rows[0] || !rows[0].valid) throw new Error('Postgres did not finish building the index. Drop it and try again.');
      // Can Postgres use it for the query that showed the issue? On a small table it still
      // prefers reading every row, so the check asks with sequential scans turned off.
      let usable = null;
      if (typeof body.sql === 'string' && explained.has(body.sql)) {
        const client = await pool.connect();
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
      await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${q(schema)}.${q(name)}`);
      return { dropped: true };
    }
    throw new Error('Unknown action.');
  }

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
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (!body) return send(400, { error: 'Bad request.' });
      storage.exit(() =>
        indexCommand(body).then(
          (out) => send(200, out),
          (err) => send(400, { error: String((err && err.message) || err) }),
        ),
      );
    });
  }

  function maybeAdvise(text) {
    if (!advisorPool || advisorOff || explained.has(text) || explained.size >= MAX_EXPLAINS) return;
    if (!/^\s*(select|with)\b/i.test(text) || text.includes(';') || /\bpg_(class|index|attribute|namespace)\b/.test(text)) return;
    explained.add(text);
    const pool = advisorPool;
    storage.exit(() => setImmediate(() => advise(pool, text).catch(() => {})));
  }

  /** App helpers that replace pool.query (timing, logging) are not where the query came from. */
  function pastWrappers(frames) {
    let i = 0;
    while (i < frames.length - 1 && /(^|\.)query$/.test(frames[i].fn)) i++;
    return i ? frames.slice(i) : frames;
  }

  function recordQuery(original, self, args) {
    const [config, values] = args;
    const text = typeof config === 'string' ? config : config && config.text;
    if (typeof text !== 'string') return original.apply(self, args);
    const params = typeof config === 'object' && config.values !== undefined ? config.values : Array.isArray(values) ? values : undefined;
    const end = begin('db', text.replace(/\s+/g, ' ').trim().slice(0, 600), { params: hashValues(params), took: paramPrints(params) });
    if (!end) return original.apply(self, args);
    const done = (res) => {
      end({ rows: res ? (res.rowCount ?? (res.rows ? res.rows.length : undefined)) : undefined, gave: res ? resultPrints(res.rows) : undefined });
      maybeAdvise(text);
    };
    const list = [...args];
    const cbIndex = list.findIndex((a) => typeof a === 'function');
    if (cbIndex !== -1) {
      const cb = list[cbIndex];
      list[cbIndex] = function (err, res) {
        if (err) end({ error: true });
        else done(res);
        return cb.apply(this, arguments);
      };
      return original.apply(self, list);
    }
    const result = original.apply(self, list);
    if (result && typeof result.then === 'function') {
      // ORMs like drizzle call the driver from a microtask, so the stack at call time may hold no
      // app code, or only a thin wrapper. Once the query settles inside this awaited function,
      // V8's async stack reaches the real caller; keep whichever stack shows more of the app.
      return (async () => {
        try {
          const res = await result;
          done(res);
          return res;
        } catch (err) {
          end({ error: true });
          throw err;
        } finally {
          const later = appFrames();
          // On a tie the later stack wins: it ends at the code that awaited the result, while the
          // stack at call time can stop at a wrapper around pool.query that did not await it.
          if (later.length && later.length >= end.span.frames.length) end.span.frames = later;
          end.span.frames = pastWrappers(end.span.frames);
        }
      })();
    }
    if (config && typeof config.on === 'function') {
      config.on('end', done);
      config.on('error', () => end({ error: true }));
    }
    return result;
  }

  function patchPg(pg) {
    const Client = pg && pg.Client;
    const Pool = pg && pg.Pool;
    if (Client && !Client.prototype.__backlens) {
      Client.prototype.__backlens = true;
      const query = Client.prototype.query;
      Client.prototype.query = function () {
        // Called by the pool, not the app: either synchronously inside pool.query, or later with no app code on the stack.
        if (insidePool || appFrames().length === 0) return query.apply(this, arguments);
        return recordQuery(query, this, [...arguments]);
      };
    }
    if (Pool && !Pool.prototype.__backlens) {
      Pool.prototype.__backlens = true;
      const query = Pool.prototype.query;
      Pool.prototype.query = function () {
        if (!advisorPool) advisorPool = this;
        const original = function () {
          insidePool = true;
          try {
            return query.apply(this, arguments);
          } finally {
            insidePool = false;
          }
        };
        return recordQuery(original, this, [...arguments]);
      };
    }
  }

  // ---- Redis (ioredis) ---------------------------------------------------------------
  // Commands whose first argument is a password or other secret: shown by name only.
  const SECRET_COMMANDS = new Set(['AUTH', 'HELLO', 'MIGRATE', 'ACL', 'CONFIG']);
  function redisLabel(name, key) {
    if (SECRET_COMMANDS.has(name) || key === undefined || key === null) return name;
    return `${name} ${redact(String(key))}`;
  }
  function patchIoredis(mod) {
    const Redis = (mod && mod.default) || mod;
    const proto = Redis && Redis.prototype;
    if (!proto || typeof proto.sendCommand !== 'function' || proto.__backlens) return;
    proto.__backlens = true;
    const sendCommand = proto.sendCommand;
    proto.sendCommand = function (command) {
      if (command && command.name) {
        const name = command.name.toUpperCase();
        const key = name === 'EVAL' || name === 'EVALSHA' ? command.args[2] : command.args[0];
        const end = begin('redis', redisLabel(name, key), { params: hashValues(command.args) });
        if (end && command.promise) command.promise.then((v) => end(name === 'GET' ? { hit: v !== null } : null), () => end({ error: true }));
      }
      return sendCommand.apply(this, arguments);
    };
  }

  // ---- Redis (node-redis v4 and v5) ----------------------------------------------------
  // Every command, pipelines and MULTI included, goes through the queue's addCommand. The client
  // keeps its own send path in private methods, so the queue is the one place to wrap.
  function patchRedisQueue(mod) {
    const Queue = mod && mod.default;
    const proto = Queue && Queue.prototype;
    if (!proto || typeof proto.addCommand !== 'function' || proto.__backlens) return;
    proto.__backlens = true;
    const addCommand = proto.addCommand;
    proto.addCommand = function (args) {
      const end =
        Array.isArray(args) && args.length && storage.getStore()
          ? (() => {
              const name = String(args[0]).toUpperCase();
              const key = name === 'EVAL' || name === 'EVALSHA' || name === 'FCALL' ? args[3] : args[1];
              return begin('redis', redisLabel(name, key), { params: hashValues(args.slice(1)) });
            })()
          : null;
      const p = addCommand.apply(this, arguments);
      if (end && p && typeof p.then === 'function') {
        const name = String(args[0]).toUpperCase();
        p.then((v) => end(name === 'GET' ? { hit: v !== null } : null), () => end({ error: true }));
      }
      return p;
    };
  }

  // ---- Prisma ---------------------------------------------------------------------------
  // Prisma 7, and Prisma 6 with a driver adapter, run SQL through `pg`, recorded already. Prisma 5
  // and 6 on the Rust engine run it inside the engine, which reports each statement with its
  // timing to a tracing helper (the hook @prisma/instrumentation uses); see prismaTracing below.
  //
  // Prisma's promises are lazy and findUnique calls are batched, so by the time SQL runs the
  // app's line is gone from the stack. Each client builds its promises with _createPrismaPromise
  // (set per instance), called right where the app calls a model method: the line is taken there.
  // _request then adds hashes of the operation's arguments, which the engine does not report.
  const prismaClients = new WeakMap();
  function scalarsOf(value, out = [], depth = 0) {
    if (out.length >= 60 || depth > 6 || value === null || value === undefined) return out;
    if (typeof value === 'object') {
      if (value instanceof Date) out.push(value.toISOString());
      else for (const v of Array.isArray(value) ? value : Object.values(value)) scalarsOf(v, out, depth + 1);
    } else out.push(value);
    return out;
  }
  function wrapPrismaPromises(client) {
    try {
      const create = client._createPrismaPromise;
      if (typeof create !== 'function' || create.__backlens) return;
      const wrapped = function (callback) {
        if (typeof callback !== 'function' || !storage.getStore()) return create.apply(this, arguments);
        const frames = appFrames();
        if (!frames.length) return create.apply(this, arguments);
        const args = [...arguments];
        args[0] = function () {
          return siteStorage.run({ frames }, () => callback.apply(this, arguments));
        };
        return create.apply(this, args);
      };
      wrapped.__backlens = true;
      client._createPrismaPromise = wrapped;
    } catch {}
  }
  function patchPrisma(mod) {
    const Client = mod.PrismaClient;
    if (typeof Client !== 'function' || Client.__backlens || !Client.prototype || typeof Client.prototype._request !== 'function') return;
    const proto = Client.prototype;
    if (!proto.__backlens) {
      proto.__backlens = true;
      const request = proto._request;
      proto._request = function (params) {
        if (!storage.getStore()) return request.apply(this, arguments);
        const outer = siteStorage.getStore();
        const args = params && params.args;
        const op = { frames: (outer && outer.frames) || appFrames(), params: hashValues(args), took: paramPrints(scalarsOf(args)), spans: [] };
        const result = siteStorage.run(op, () => request.apply(this, arguments));
        if (!result || typeof result.then !== 'function') return result;
        return result.then((res) => {
          try {
            const rows = Array.isArray(res) ? res : res && typeof res === 'object' ? [res] : undefined;
            const gave = resultPrints(rows);
            for (const span of op.spans) {
              if (span.rows === undefined && rows) span.rows = rows.length;
              if (gave && !span.gave) span.gave = gave;
            }
          } catch {}
          return res;
        });
      };
    }
    let Wrapped = prismaClients.get(Client);
    if (!Wrapped) {
      Wrapped = class PrismaClient extends Client {
        constructor() {
          super(...arguments);
          wrapPrismaPromises(this);
        }
      };
      Wrapped.__backlens = true;
      prismaClients.set(Client, Wrapped);
    }
    try {
      mod.PrismaClient = Wrapped;
    } catch {}
  }

  // Installed only when the app has no tracing of its own, which would take precedence anyway.
  // Only requests being recorded are sampled; the engine collects nothing for the rest.
  function prismaTracing() {
    const g = globalThis;
    if (g.PRISMA_INSTRUMENTATION || Object.keys(g).some((k) => /^V\d+_PRISMA_INSTRUMENTATION$/.test(k))) return;
    const hex = (n) => require('node:crypto').randomBytes(n).toString('hex');
    const ms = (t) => (Array.isArray(t) ? t[0] * 1e3 + t[1] / 1e6 : Number(t));
    g.PRISMA_INSTRUMENTATION = {
      helper: {
        isEnabled: () => true,
        getTraceParent: () => `00-${hex(16)}-${hex(8)}-${storage.getStore() ? '01' : '00'}`,
        getActiveContext: () => undefined,
        runInChildSpan: (_options, callback) => callback(),
        dispatchEngineSpans(spans) {
          try {
            const trace = storage.getStore();
            if (!trace || trace.began === undefined || !Array.isArray(spans)) return;
            const op = siteStorage.getStore();
            for (const s of spans) {
              const text = s && s.name === 'prisma:engine:db_query' && s.attributes && (s.attributes['db.query.text'] || s.attributes['db.statement']);
              if (typeof text !== 'string' || trace.spans.length >= MAX_SPANS) continue;
              const name = text.replace(/\s+/g, ' ').trim().slice(0, 600);
              const start = round(ms(s.startTime) - performance.timeOrigin - trace.began);
              // With a driver adapter the same statement already came through pg.
              if (trace.spans.some((x) => x.kind === 'db' && !x.engine && x.name === name && Math.abs(x.start - start) < 3)) continue;
              const span = {
                kind: 'db',
                name,
                start,
                duration: round(ms(s.endTime) - ms(s.startTime)),
                frames: (op && op.frames) || appFrames(),
                params: op ? op.params : null,
                took: op ? op.took : undefined,
                engine: true,
              };
              trace.spans.push(span);
              if (op) op.spans.push(span);
            }
          } catch {}
        },
      },
    };
  }
  prismaTracing();

  // ---- outgoing http and https (axios, got, node-fetch, SDKs) ---------------------------
  // Global fetch runs on undici and never reaches these, so nothing is counted twice. The
  // recorder's own reports run outside any request, where begin() records nothing.
  function describeRequest(req, fallback) {
    try {
      const host = (typeof req.getHeader === 'function' && req.getHeader('host')) || req.host || '';
      return `${req.method || 'GET'} ${host}${String(req.path || '/').split('?')[0]}`;
    } catch {
      return fallback;
    }
  }
  function wrapOutgoing(mod, scheme) {
    for (const fn of ['request', 'get']) {
      const original = mod[fn];
      if (typeof original !== 'function' || original.__backlens) continue;
      const wrapped = function () {
        const req = original.apply(this, arguments);
        if (!storage.getStore() || !req || typeof req.once !== 'function') return req;
        const end = begin('http', describeRequest(req, scheme));
        if (!end) return req;
        let done = false;
        const finish = (detail) => {
          if (done) return;
          done = true;
          end(detail);
        };
        req.once('response', (res) => {
          const status = res.statusCode;
          res.once('end', () => finish({ status }));
          res.once('close', () => finish({ status }));
        });
        req.once('error', () => finish({ error: true }));
        req.once('close', () => finish(null));
        return req;
      };
      wrapped.__backlens = true;
      mod[fn] = wrapped;
    }
  }
  wrapOutgoing(http, 'http');
  wrapOutgoing(https, 'https');
  try {
    // ESM `import { request } from 'node:http'` reads a copy of the exports; this refreshes it.
    Module.syncBuiltinESMExports();
  } catch {}

  // ---- outgoing fetch ----------------------------------------------------------------
  if (typeof globalThis.fetch === 'function') {
    const fetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      let label = 'fetch';
      try {
        const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        label = `${(init && init.method) || (input && input.method) || 'GET'} ${u.host}${u.pathname}`;
      } catch {}
      const end = begin('http', label);
      const p = fetch.apply(this, arguments);
      if (end) p.then((r) => end({ status: r.status }), () => end({ error: true }));
      return p;
    };
  }

  // ---- routes the app registers ---------------------------------------------------------
  // Known up front, so the dashboard can list routes that were never called.
  const routes = new Map();
  let routesTimer = null;
  function addRoute(method, url) {
    if (!url || method === 'HEAD' || (method === 'OPTIONS' && url.includes('*'))) return;
    routes.set(`${method} ${url}`, { method, path: url });
    clearTimeout(routesTimer);
    routesTimer = setTimeout(() => {
      post('/routes', { pid: process.pid, routes: [...routes.values()] });
    }, 300);
    if (routesTimer.unref) routesTimer.unref();
  }

  const wrappedFastify = new WeakMap();
  function wrapFastify(factory) {
    if (typeof factory !== 'function') return factory;
    if (wrappedFastify.has(factory)) return wrappedFastify.get(factory);
    const wrapped = function () {
      const app = factory.apply(this, arguments);
      try {
        app.addHook('onRoute', (opts) => {
          for (const method of [].concat(opts.method)) addRoute(String(method).toUpperCase(), opts.url);
        });
        app.addHook('onRequest', (req, _reply, done) => {
          const trace = storage.getStore();
          const url = req.routeOptions && req.routeOptions.url;
          if (trace && url) trace.template = url;
          done();
        });
      } catch {}
      return app;
    };
    Object.assign(wrapped, factory);
    wrapped.fastify = wrapped;
    wrapped.default = wrapped;
    wrappedFastify.set(factory, wrapped);
    return wrapped;
  }

  // ---- patch libraries when the app loads them -----------------------------------------
  const load = Module._load;
  Module._load = function (request) {
    const exported = load.apply(this, arguments);
    try {
      if (request === 'pg') patchPg(exported);
      else if (request === 'ioredis') patchIoredis(exported);
      else if (request === 'fastify') return wrapFastify(exported);
      else if (request.endsWith('/commands-queue')) patchRedisQueue(exported);
      else if (exported && typeof exported.PrismaClient === 'function') patchPrisma(exported);
    } catch {}
    return exported;
  };

  patchFromApp();
}
