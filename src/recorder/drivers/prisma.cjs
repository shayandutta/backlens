'use strict';
/**
 * Prisma. Prisma 7, and Prisma 6 with a driver adapter, run SQL through `pg`, recorded already.
 * Prisma 5 and 6 on the Rust engine run it inside the engine, which reports each statement with its
 * timing to a tracing helper (the hook @prisma/instrumentation uses); see installTracing below.
 *
 * Prisma's promises are lazy and findUnique calls are batched, so by the time SQL runs the app's
 * line is gone from the stack. Each client builds its promises with _createPrismaPromise (set per
 * instance), called right where the app calls a model method: the line is taken there. _request
 * then adds hashes of the operation's arguments, which the engine does not report.
 */

const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { MAX_SPANS, round, siteStorage, storage } = require('../context.cjs');
const { appFrames } = require('../frames.cjs');
const { hashValues, paramPrints, resultPrints, scalarsOf } = require('../privacy.cjs');

const prismaClients = new WeakMap();

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
function installTracing() {
  const g = globalThis;
  if (g.PRISMA_INSTRUMENTATION || Object.keys(g).some((k) => /^V\d+_PRISMA_INSTRUMENTATION$/.test(k))) return;
  const hex = (n) => randomBytes(n).toString('hex');
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

module.exports = { patchPrisma, installTracing };
