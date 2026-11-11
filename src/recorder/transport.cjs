'use strict';
/** Reports to the dashboard over local HTTP, and checks the dashboard's token on commands it sends. */

const { timingSafeEqual } = require('node:crypto');
const http = require('node:http');
const { storage } = require('./context.cjs');
const { SOURCE, TARGET, TOKEN } = require('./env.cjs');

const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

/** Reports to the dashboard, outside any request so the report itself is never recorded. */
function post(pathname, payload) {
  const body = JSON.stringify(payload);
  storage.exit(() => {
    const req = http.request(new URL(pathname, TARGET), {
      method: 'POST',
      agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-backlens-token': TOKEN },
    });
    req.on('error', () => {});
    req.end(body);
  });
}

/** Sends a finished trace. */
function send(trace) {
  trace.source = SOURCE;
  post('/ingest', trace);
}

function tokenOk(value) {
  if (!TOKEN || typeof value !== 'string' || value.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(TOKEN));
}

module.exports = { post, send, tokenOk };
