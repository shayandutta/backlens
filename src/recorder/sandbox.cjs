'use strict';
/**
 * The write sandbox. A replayed request sent with `x-backlens-sandbox: 1` runs every Postgres query
 * of that request on one connection, inside a transaction that is rolled back when the response is
 * done, so replaying a POST, PUT or DELETE changes nothing in the database.
 *
 * - pool.query and pool.connect inside the request get that one pinned connection.
 * - The app's own transaction statements become savepoints (BEGIN -> SAVEPOINT, COMMIT -> RELEASE,
 *   ROLLBACK -> ROLLBACK TO), so nothing the app does can commit the outer transaction.
 * - A query on any other connection (a Client the app made itself) is counted as a leak, and the
 *   dashboard says loudly that writes may have persisted.
 * - Once the response is done the transaction is rolled back and the connection released; a query
 *   after that (fire-and-forget work) is refused.
 *
 * Only Postgres through `pg` is covered. Redis writes and other side effects are not rolled back:
 * the dashboard refuses to sandbox a request that called out over HTTP, and lists Redis writes.
 */

const { storage } = require('./context.cjs');

const TX_BEGIN = /^\s*(begin|start\s+transaction)\b/i;
const TX_COMMIT = /^\s*(commit|end)\b/i;
const TX_ROLLBACK = /^\s*rollback\s*(;|$)/i;

/** The sandbox of the request this code runs for, or null. */
function current() {
  const trace = storage.getStore();
  return trace && trace.sandbox ? trace.sandbox : null;
}

/** A fresh sandbox state, attached to the trace by the incoming-request patch. */
function create() {
  return { client: null, opening: null, rawQuery: null, closed: false, depth: 0, statements: 0, leaked: 0, rolledBack: false, error: null };
}

/** The pinned connection, opened (with BEGIN) on first use. `connect` and `rawQuery` are the unpatched pool and client methods. */
function pinned(sb, pool, connect, rawQuery) {
  if (sb.closed) return Promise.reject(new Error('backlens sandbox: the replayed request already finished; this query was refused'));
  if (sb.client) return Promise.resolve(sb.client);
  if (!sb.opening) {
    sb.opening = (async () => {
      const client = await connect.call(pool);
      sb.rawQuery = rawQuery;
      await rawQuery.call(client, 'BEGIN');
      sb.client = client;
      return client;
    })();
    sb.opening.catch((err) => (sb.error = String((err && err.message) || err)));
  }
  return sb.opening;
}

/** The text to run instead, for the app's own transaction statements inside the sandbox. */
function rewrite(sb, text) {
  if (typeof text !== 'string') return text;
  if (TX_BEGIN.test(text)) return `SAVEPOINT backlens_${++sb.depth}`;
  if (TX_COMMIT.test(text)) return sb.depth > 0 ? `RELEASE SAVEPOINT backlens_${sb.depth--}` : 'SELECT 1';
  if (TX_ROLLBACK.test(text)) return sb.depth > 0 ? `ROLLBACK TO SAVEPOINT backlens_${sb.depth--}` : 'SELECT 1';
  return text;
}

/** Rewrites a query's arguments (string or config object) for the sandbox. */
function rewriteArgs(sb, args) {
  const [config, ...rest] = args;
  if (typeof config === 'string') return [rewrite(sb, config), ...rest];
  if (config && typeof config.text === 'string') return [{ ...config, text: rewrite(sb, config.text) }, ...rest];
  return args;
}

/** A client the app can use as if it came from pool.connect(); release() leaves the pinned connection open. */
function lease(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'release') return () => {};
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** Ends the sandbox after the response: rolls back, releases, and reports what happened. */
async function close(sb) {
  sb.closed = true;
  if (sb.opening) await sb.opening.catch(() => {});
  if (sb.client) {
    try {
      await sb.rawQuery.call(sb.client, 'ROLLBACK');
      sb.rolledBack = true;
    } catch (err) {
      sb.error = String((err && err.message) || err);
    }
    try {
      sb.client.release(true);
    } catch {}
  }
  return { statements: sb.statements, leaked: sb.leaked, rolledBack: sb.rolledBack || !sb.client, error: sb.error };
}

module.exports = { current, create, pinned, rewriteArgs, lease, close };
