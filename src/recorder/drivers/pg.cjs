'use strict';
/**
 * Postgres through `pg` (Client and Pool), which drizzle, Kysely, knex and Prisma's pg adapter all
 * use. Pool queries are recorded where the app calls pool.query: the client query inside may run
 * later, in the context of whichever request freed a connection, and is skipped.
 */

const { begin, storage } = require('../context.cjs');
const { appFrames } = require('../frames.cjs');
const { maybeAdvise, usePool } = require('../index-advisor.cjs');
const { hashValues, paramPrints, resultPrints } = require('../privacy.cjs');
const sandbox = require('../sandbox.cjs');

let insidePool = false;
// Clients the app leased with pool.connect() inside a request -> that request's trace. An ORM
// drives such a client (a transaction) from microtasks with no app code on the stack; its queries
// are still the app's, so they are recorded for that request (and only that one).
const leases = new WeakMap();

/** backlens's own queries (the index advisor) are tagged and never recorded or sandboxed. */
const isOwn = (config) => Boolean(config && typeof config === 'object' && config.__backlens);

function lease(client) {
  const trace = storage.getStore();
  if (!client || !trace) return client;
  leases.set(client, trace);
  // pg-pool gives the client a new release() on every acquire, so wrap whatever is there now.
  const release = client.release;
  if (typeof release === 'function' && !release.__backlens) {
    const wrapped = function () {
      leases.delete(client);
      return release.apply(this, arguments);
    };
    wrapped.__backlens = true;
    client.release = wrapped;
  }
  return client;
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
  const end = begin('db', text.replace(/\s+/g, ' ').trim().slice(0, 600), { params: hashValues(params), took: paramPrints(params), drv: 'pg' });
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
  const rawClientQuery = Client && Client.prototype.query;
  if (Client && !Client.prototype.__backlens) {
    Client.prototype.__backlens = true;
    const query = Client.prototype.query;
    Client.prototype.query = function () {
      if (isOwn(arguments[0])) return query.apply(this, arguments);
      let args = [...arguments];
      // In a write sandbox: the pinned connection runs the app's transaction statements as
      // savepoints; any other connection used by this request is a leak the dashboard reports.
      const sb = sandbox.current();
      if (sb && !insidePool && !sb.closed) {
        if (this === sb.client) {
          sb.statements++;
          args = sandbox.rewriteArgs(sb, args);
        } else sb.leaked++;
      }
      // Called by the pool, not the app: either synchronously inside pool.query, or later with no
      // app code on the stack, unless the app leased this client for the current request.
      const leased = (sb && this === sb.client) || (leases.has(this) && leases.get(this) === storage.getStore());
      if (insidePool || (appFrames().length === 0 && !leased)) return query.apply(this, args);
      return recordQuery(query, this, args);
    };
  }
  if (Pool && !Pool.prototype.__backlens) {
    Pool.prototype.__backlens = true;
    const query = Pool.prototype.query;
    const connect = Pool.prototype.connect;
    Pool.prototype.connect = function (cb) {
      const sb = sandbox.current();
      if (!sb) {
        // pool.query connects for itself (insidePool): not the app's lease, whatever the client
        // was used for before it went back to the pool.
        if (insidePool && typeof cb === 'function') return connect.call(this, (err, client, done) => (leases.delete(client), cb(err, client, done)));
        if (insidePool || !storage.getStore()) return connect.apply(this, arguments);
        if (typeof cb === 'function') return connect.call(this, (err, client, done) => cb(err, lease(client), done && ((e) => (leases.delete(client), done(e)))));
        return connect.apply(this, arguments).then(lease);
      }
      // The request's pinned connection, lent out; release() keeps it open for the rollback.
      const p = sandbox.pinned(sb, this, connect, rawClientQuery).then(sandbox.lease);
      if (typeof cb !== 'function') return p;
      p.then((c) => cb(null, c, () => {}), (err) => cb(err));
      return undefined;
    };
    Pool.prototype.query = function () {
      if (isOwn(arguments[0])) return query.apply(this, arguments);
      usePool(this);
      const sb = sandbox.current();
      if (sb) {
        const pool = this;
        // The same recording, but the query runs on the pinned connection inside the transaction.
        const pinnedQuery = function (...a) {
          const cbIndex = a.findIndex((x) => typeof x === 'function');
          const cb = cbIndex === -1 ? null : a.splice(cbIndex, 1)[0];
          const p = sandbox.pinned(sb, pool, connect, rawClientQuery).then((c) => {
            sb.statements++;
            return rawClientQuery.apply(c, sandbox.rewriteArgs(sb, a));
          });
          if (!cb) return p;
          p.then((res) => cb(null, res), (err) => cb(err));
          return undefined;
        };
        return recordQuery(pinnedQuery, this, [...arguments]);
      }
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

module.exports = { patchPg };
