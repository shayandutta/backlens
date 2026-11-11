'use strict';
/** Patches libraries as the app loads them, through CommonJS and (via the shared cache) ESM. */

const Module = require('node:module');
const path = require('node:path');
const { patchPg } = require('./drivers/pg.cjs');
const { patchPrisma } = require('./drivers/prisma.cjs');
const { patchIoredis, patchRedisQueue } = require('./drivers/redis.cjs');
const { wrapFastify } = require('./frameworks/fastify.cjs');

function hookRequire() {
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
}

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

module.exports = { hookRequire, patchFromApp };
