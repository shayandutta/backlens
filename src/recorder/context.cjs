'use strict';
/**
 * The request being recorded, carried through async calls, and spans: one recorded call (SQL,
 * Redis, outgoing HTTP) inside it.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { appFrames } = require('./frames.cjs');

const MAX_SPANS = 300;
/** The trace of the incoming request this code runs for. */
const storage = new AsyncLocalStorage();
/** The app code that called an ORM operation, for the queries that operation runs later. */
const siteStorage = new AsyncLocalStorage();

const now = () => performance.now();
const round = (n) => Math.round(n * 100) / 100;

/**
 * Starts a span for the current request, or returns null outside one. Returns end(detail), which
 * stops the clock and merges detail into the span; end.span is the span itself.
 */
function begin(kind, name, extra) {
  const trace = storage.getStore();
  if (!trace || trace.spans.length >= MAX_SPANS) return null;
  let frames = appFrames();
  // ORMs that batch or schedule queries lose the async stack; fall back to where the app called the ORM.
  if (!frames.length) frames = (siteStorage.getStore() || {}).frames || [];
  const span = { kind, name, start: round(now() - trace.began), duration: 0, frames, ...extra };
  trace.spans.push(span);
  const t0 = now();
  const end = (detail) => {
    span.duration = round(now() - t0);
    if (detail) Object.assign(span, detail);
  };
  end.span = span;
  return end;
}

module.exports = { MAX_SPANS, storage, siteStorage, now, round, begin };
