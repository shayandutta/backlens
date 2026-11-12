'use strict';
/**
 * What the recorder hooked into in this process, for `backlens doctor`: each adapter (pg, ioredis,
 * node-redis, Prisma, fastify, the HTTP server and clients, fetch) with the library's version and a
 * status:
 *
 *   ok        patched, on a version the compatibility matrix tests
 *   untested  patched, but this major version is not in the matrix: results may be off
 *   shared    another tool (OpenTelemetry, an APM agent) had already wrapped the same methods
 *
 * Reported to the dashboard shortly after each change. Never throws into the app.
 */

const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { post } = require('./transport.cjs');

// Major versions the compatibility matrix (test/compat) runs. Keep in step with it.
const TESTED = {
  pg: ['8'],
  ioredis: ['5'],
  redis: ['4', '5'],
  '@redis/client': ['1', '5'],
  fastify: ['4', '5'],
  '@prisma/client': ['5', '6', '7'],
};

const found = new Map();
let timer = null;

/** The installed version of a package, as the app would load it; null if unknown. */
function versionOf(name) {
  try {
    const req = Module.createRequire(path.join(process.cwd(), 'backlens-probe.js'));
    let dir = path.dirname(req.resolve(name));
    for (let i = 0; i < 6; i++) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (pkg.name === name && pkg.version) return pkg.version;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {}
  return null;
}

/** True when a function was already wrapped by another instrumentation tool (shimmer, OpenTelemetry). */
const foreign = (fn) => Boolean(fn && (fn.__wrapped || fn.__original || fn.__unwrap || fn.__ddWrapped));

function report() {
  timer = null;
  try {
    post('/adapters', { pid: process.pid, adapters: [...found.values()] });
  } catch {}
}

/**
 * Notes an adapter. `pkg`: the package whose version to look up (and check against TESTED);
 * `wrapped`: the methods were already wrapped by another tool before backlens patched them.
 */
function note(name, { pkg = null, wrapped = false } = {}) {
  try {
    // A package is loaded (and seen) many times; by the second time backlens's own wrapper is
    // what is there, so the first look is the one that can tell.
    if (found.has(name)) return;
    const version = pkg ? versionOf(pkg) : process.versions.node;
    const major = version ? version.split('.')[0] : null;
    let status = 'ok';
    let why = null;
    if (wrapped) {
      status = 'shared';
      why = 'another instrumentation tool wrapped these methods first; calls may be recorded twice or missed';
    } else if (pkg && TESTED[pkg] && major && !TESTED[pkg].includes(major)) {
      status = 'untested';
      why = `version ${version} is not in the compatibility matrix (tested: ${TESTED[pkg].map((m) => `${m}.x`).join(', ')})`;
    }
    found.set(name, { name, package: pkg, version, status, why });
    if (!timer) {
      timer = setTimeout(report, 50);
      if (timer.unref) timer.unref();
    }
  } catch {}
}

module.exports = { note, foreign, versionOf, TESTED };
