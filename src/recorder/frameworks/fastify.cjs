'use strict';
/**
 * Routes the app registers, known up front so the dashboard can list routes nobody called yet,
 * and fastify's route templates (express sets req.route itself; see incoming.cjs).
 */

const { storage } = require('../context.cjs');
const { post } = require('../transport.cjs');

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

module.exports = { wrapFastify };
