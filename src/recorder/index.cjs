'use strict';
/**
 * The recorder, loaded inside the app with --require (NODE_OPTIONS, or `backlens/register`).
 * Records each incoming HTTP request and the Postgres, Redis and outgoing HTTP calls it makes, with
 * the line of app code behind each call, and sends the finished trace to the backlens dashboard.
 * Query values are never sent: only a hash of them (see privacy.cjs).
 *
 * Off unless the dashboard started this process (BACKLENS_URL), and installed once per process.
 * Recording must never break the app: every patch swallows its own failures.
 */

const { TARGET } = require('./env.cjs');

if (TARGET && !globalThis.__backlens) {
  globalThis.__backlens = true;
  require('./incoming.cjs').patchServers();
  require('./drivers/prisma.cjs').installTracing();
  const { patchFetch, patchHttpClients } = require('./drivers/outgoing.cjs');
  patchHttpClients();
  patchFetch();
  const { hookRequire, patchFromApp } = require('./loader.cjs');
  hookRequire();
  patchFromApp();
}
