'use strict';
/**
 * Incoming requests. Each request on Node's own HTTP server becomes a trace, so any framework on
 * top of it works. The request itself (method, url, headers, body up to 64 KB) is kept so it can be
 * replayed against changed code; it goes only to the local dashboard's memory, never to disk or a
 * model.
 */

const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { now, round, storage } = require('./context.cjs');
const { SOURCE } = require('./env.cjs');
const { handleCommand } = require('./index-advisor.cjs');
const { captureBody } = require('./shape.cjs');
const { post, send, tokenOk } = require('./transport.cjs');

// Framework internals and browser asset fetches, not the app's own routes: Next.js build
// assets, dev overlay and HMR, Vite dev files, favicons and source maps.
const INTERNAL = /^\/(?:_next\/|__nextjs|@vite\/|@fs\/|@id\/|node_modules\/|favicon\.ico(?:$|\?))|\.map(?:$|\?)/;
const MAX_REPLAY_BODY = 65536;

function patchServers() {
  for (const Server of [http.Server, https.Server]) {
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req, res) {
      if (event === 'listening') {
        try {
          const address = this.address();
          if (address && typeof address === 'object') post('/listening', { port: address.port, pid: process.pid, source: SOURCE });
        } catch {}
      }
      if (event === 'request' && req && res && req.url === '/__backlens/index' && req.method === 'POST' && tokenOk(req.headers['x-backlens-token'])) {
        handleCommand(req, res);
        return true;
      }
      if (event !== 'request' || !req || !res || req.headers['x-backlens'] === 'skip' || INTERNAL.test(req.url || '')) return emit.apply(this, arguments);
      const trace = {
        id: randomUUID(),
        pid: process.pid,
        method: req.method,
        url: (req.url || '/').split('?')[0],
        status: 0,
        at: Date.now(),
        began: now(),
        duration: 0,
        spans: [],
      };
      const replayOf = req.headers['x-backlens-replay'];
      if (replayOf) trace.replayOf = String(replayOf);
      // The behavior diff asks for the response's shape (paths and types, no values) on its replays.
      const shapeDone = replayOf && req.headers['x-backlens-shape'] === '1' ? captureBody(res) : null;
      const chunks = [];
      let bodySize = 0;
      const reqEmit = req.emit;
      req.emit = function (ev, chunk) {
        if (ev === 'data' && chunk && bodySize <= MAX_REPLAY_BODY) {
          bodySize += chunk.length;
          if (bodySize <= MAX_REPLAY_BODY) chunks.push(Buffer.from(chunk));
        }
        return reqEmit.apply(this, arguments);
      };
      let sent = false;
      const finish = (aborted) => {
        if (!sent && !replayOf) {
          const headers = { ...req.headers };
          for (const h of ['host', 'content-length', 'connection', 'transfer-encoding', 'x-backlens-replay']) delete headers[h];
          trace.replay = bodySize > MAX_REPLAY_BODY ? { truncated: true } : { method: req.method, url: req.url, headers, body: chunks.length ? Buffer.concat(chunks).toString('base64') : null };
        }
        if (sent) return;
        sent = true;
        // express sets req.route once a route matched; fastify's template arrives via its onRequest hook.
        if (!trace.template && req.route && typeof req.route.path === 'string') trace.template = `${req.baseUrl || ''}${req.route.path}`;
        trace.status = aborted ? 499 : res.statusCode;
        if (shapeDone) trace.shape = shapeDone();
        if (aborted) trace.aborted = true;
        trace.duration = round(now() - trace.began);
        delete trace.began;
        // Spans reported after the fact (Prisma's engine) are added late: keep them in time order.
        trace.spans.sort((a, b) => a.start - b.start);
        send(trace);
      };
      res.once('finish', () => finish(false));
      // The browser gave up (navigated away, timed out) before the response was sent.
      res.once('close', () => finish(!res.writableFinished));
      return storage.run(trace, () => emit.apply(this, arguments));
    };
  }
}

module.exports = { patchServers };
