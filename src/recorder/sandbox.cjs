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
 *
 * A group (`x-backlens-sandbox: group:<id>:<n>`, the concurrency probes): n replayed requests share
 * one pinned connection and one transaction, so each sees what the others wrote, as copies of a
 * request racing on a real database would. Their statements interleave one at a time, each behind
 * its own savepoint, so one failing statement (a unique violation) fails only itself. The app's own
 * transaction statements become no-ops (requests interleave inside them), and an app ROLLBACK is
 * counted, since it cannot be honoured. The transaction is rolled back once all n have finished
 * (or after GROUP_TIMEOUT_MS); the last request's trace carries the result.
 */

const { storage } = require('./context.cjs');

const TX_BEGIN = /^\s*(begin|start\s+transaction)\b/i;
const TX_COMMIT = /^\s*(commit|end)\b/i;
const TX_ROLLBACK = /^\s*rollback\s*(;|$)/i;
const APP_SAVEPOINT = /^\s*(savepoint|release(\s+savepoint)?|rollback\s+to(\s+savepoint)?)\s/i;
const GROUP = /^group:([\w-]{1,64}):(\d{1,3})$/;
const GROUP_TIMEOUT_MS = 30_000;
const groups = new Map();

/** The sandbox of the request this code runs for, or null. */
function current() {
  const trace = storage.getStore();
  return trace && trace.sandbox ? trace.sandbox : null;
}

/** A fresh sandbox state, attached to the trace by the incoming-request patch. */
function create() {
  return { client: null, opening: null, rawQuery: null, closed: false, depth: 0, statements: 0, leaked: 0, rolledBack: false, error: null, group: null, queue: null, appRollbacks: 0 };
}

/** The shared sandbox of a group, from the header value; null when the value is not a group. */
function join(value) {
  const m = GROUP.exec(String(value || ''));
  if (!m) return null;
  let g = groups.get(m[1]);
  if (!g) {
    const sb = { ...create(), group: m[1], queue: Promise.resolve() };
    g = { id: m[1], sb, expected: Math.max(1, Number(m[2])), left: 0, finished: false };
    g.result = new Promise((resolve) => (g.resolve = resolve));
    g.timer = setTimeout(() => finishGroup(g), GROUP_TIMEOUT_MS);
    if (g.timer.unref) g.timer.unref();
    groups.set(g.id, g);
  }
  return g.sb;
}

function finishGroup(g) {
  if (g.finished) return;
  g.finished = true;
  clearTimeout(g.timer);
  groups.delete(g.id);
  close(g.sb).then((r) => g.resolve({ ...r, group: g.id, final: true, members: g.left, expected: g.expected }));
}

/**
 * A request in the sandbox finished. Alone: roll back now. In a group: the last of the n rolls back
 * and reports the result; the others report that they took part.
 */
function leave(sb) {
  if (!sb.group) return close(sb);
  const g = groups.get(sb.group);
  if (!g) return Promise.resolve({ group: sb.group, member: true, error: 'the group was already closed (timed out) when this request finished' });
  g.left++;
  if (g.left < g.expected) return Promise.resolve({ group: g.id, member: true });
  finishGroup(g);
  return g.result;
}

/**
 * Runs one statement of a group on the shared connection: one at a time, behind a savepoint, so a
 * failure is undone alone and the transaction stays usable for the other requests.
 */
function guarded(sb, exec) {
  const raw = (text) => sb.rawQuery.call(sb.client, text);
  const go = sb.queue.then(async () => {
    await raw('SAVEPOINT backlens_q');
    try {
      const res = await exec();
      await raw('RELEASE SAVEPOINT backlens_q');
      return res;
    } catch (err) {
      await raw('ROLLBACK TO SAVEPOINT backlens_q').catch(() => {});
      throw err;
    }
  });
  sb.queue = go.catch(() => {});
  return go;
}

/** A query function for the pinned connection: guarded in a group, direct otherwise. Takes pg's (text, values, cb) forms. */
function runner(sb, run, open = null) {
  return function (...a) {
    const cbIndex = a.findIndex((x) => typeof x === 'function');
    const cb = cbIndex === -1 ? null : a.splice(cbIndex, 1)[0];
    const args = rewriteArgs(sb, a);
    // `open`: the pinned connection must exist before a group's savepoint can be taken on it.
    const p = sb.group ? (open ? open() : Promise.resolve()).then(() => guarded(sb, () => run(args))) : run(args);
    if (!cb) return p;
    p.then((res) => cb(null, res), (err) => cb(err));
    return undefined;
  };
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
  if (sb.group) {
    // Several requests interleave inside one transaction: their own transactions cannot nest.
    if (TX_ROLLBACK.test(text)) sb.appRollbacks++;
    return TX_BEGIN.test(text) || TX_COMMIT.test(text) || TX_ROLLBACK.test(text) || APP_SAVEPOINT.test(text) ? 'SELECT 1' : text;
  }
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
  if (sb.queue) await sb.queue;
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
  const out = { statements: sb.statements, leaked: sb.leaked, rolledBack: sb.rolledBack || !sb.client, error: sb.error };
  if (sb.group) out.appRollbacks = sb.appRollbacks;
  return out;
}

module.exports = { current, create, join, leave, pinned, rewriteArgs, runner, lease, close };
