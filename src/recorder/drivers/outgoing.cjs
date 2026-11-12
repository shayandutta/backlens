'use strict';
/**
 * Outgoing calls: `http`/`https` (axios, got, node-fetch, most SDKs) and global fetch. Global fetch
 * runs on undici and never reaches http/https, so nothing is counted twice. The recorder's own
 * reports run outside any request, where begin() records nothing.
 */

const http = require('node:http');
const https = require('node:https');
const Module = require('node:module');
const { begin, storage } = require('../context.cjs');

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

function patchHttpClients() {
  wrapOutgoing(http, 'http');
  wrapOutgoing(https, 'https');
  try {
    // ESM `import { request } from 'node:http'` reads a copy of the exports; this refreshes it.
    Module.syncBuiltinESMExports();
  } catch {}
}

function patchFetch() {
  if (typeof globalThis.fetch !== 'function') return;
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

module.exports = { patchHttpClients, patchFetch };
