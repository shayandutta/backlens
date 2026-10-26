'use strict';
/**
 * Loaded inside the app with --require. Records each incoming HTTP request and the Postgres,
 * Redis and fetch calls it makes, with the line of app code behind each call, and sends the
 * finished trace to the backlens dashboard. Query values are never sent: only a hash of them,
 * so two identical questions can be told apart from two different ones.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, randomUUID } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const Module = require('node:module');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const TARGET = process.env.BACKLENS_URL;
const ROOT = process.env.BACKLENS_ROOT || process.cwd();
const SELF = __dirname;
const MAX_SPANS = 300;

if (TARGET && !globalThis.__backlens) {
  globalThis.__backlens = true;
  const storage = new AsyncLocalStorage();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

  const now = () => performance.now();
  const round = (n) => Math.round(n * 100) / 100;

  /** The first few frames of app code that led to this call, skipping node, node_modules and backlens. */
  function appFrames() {
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
      const file = m[2].replace(/^file:\/\//, '');
      if (file.startsWith('node:') || file.includes('node_modules') || file.startsWith(SELF) || !file.startsWith('/')) continue;
      frames.push({ fn: (m[1] || '').replace(/^async /, '') || '(anonymous)', file: path.relative(ROOT, file), line: Number(m[3]) });
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
    const span = { kind, name, start: round(now() - trace.began), duration: 0, frames: appFrames(), ...extra };
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
    for (const name of ['pg', 'ioredis']) {
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
  for (const Server of [http.Server, https.Server]) {
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req, res) {
      if (event === 'listening') {
        try {
          const address = this.address();
          if (address && typeof address === 'object') post('/listening', { port: address.port, pid: process.pid, source: SOURCE });
        } catch {}
      }
      if (event !== 'request' || !req || !res || req.headers['x-backlens'] === 'skip') return emit.apply(this, arguments);
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

  function seqScans(node, out = []) {
    if (!node) return out;
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] && node.Filter) {
      const columns = columnsCompared(node.Filter);
      if (columns.length) out.push({ table: node['Relation Name'], schema: node.Schema || 'public', columns, filter: node.Filter });
    }
    for (const child of node.Plans || []) seqScans(child, out);
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
      post('/advice', { sql: text, table: scan.table, schema: scan.schema, columns: scan.columns, rows: Math.max(0, Number(rows[0].rows)) });
    }
  }

  function maybeAdvise(text) {
    if (!advisorPool || advisorOff || explained.has(text) || explained.size >= MAX_EXPLAINS) return;
    if (!/^\s*(select|with)\b/i.test(text) || text.includes(';') || /\bpg_(class|index|attribute|namespace)\b/.test(text)) return;
    explained.add(text);
    const pool = advisorPool;
    storage.exit(() => setImmediate(() => advise(pool, text).catch(() => {})));
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
          if (later.length > end.span.frames.length) end.span.frames = later;
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
        const end = begin('redis', `${name}${key !== undefined ? ` ${redact(key)}` : ''}`, { params: hashValues(command.args) });
        if (end && command.promise) command.promise.then((v) => end(name === 'GET' ? { hit: v !== null } : null), () => end({ error: true }));
      }
      return sendCommand.apply(this, arguments);
    };
  }

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
    } catch {}
    return exported;
  };

  patchFromApp();
}
