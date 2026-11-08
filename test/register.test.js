import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTER = join(dirname(fileURLToPath(import.meta.url)), '..', 'register.cjs');

/**
 * Runs a tiny app whose handler lives in a bundled chunk with an external source map, the way
 * Next.js with Turbopack ships code, and returns the traces the recorder sends.
 */
async function record(paths, files = {}, main = 'server.js') {
  const dir = mkdtempSync(join(tmpdir(), 'backlens-register-'));
  mkdirSync(join(dir, '.next'));
  // Line 3 of the chunk maps to line 10 of src/app.ts.
  writeFileSync(
    join(dir, '.next', 'chunk.js'),
    ['// generated', 'module.exports = async function handler(url) {', '  return await fetch(url);', '};', '//# sourceMappingURL=chunk.js.map', ''].join('\n'),
  );
  writeFileSync(
    join(dir, '.next', 'chunk.js.map'),
    JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ['../src/app.ts'], names: [], mappings: ';;AASA' } }] }),
  );
  writeFileSync(
    join(dir, 'server.js'),
    `const http = require('node:http');
const handler = require('./.next/chunk.js');
const server = http.createServer(async (req, res) => {
  if (req.url === '/ping') return res.end('pong');
  if (req.url === '/call') await handler('http://127.0.0.1:' + server.address().port + '/ping');
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`,
  );

  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }

  const traces = [];
  const sink = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      if (req.url === '/ingest') traces.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--require', REGISTER, main], {
    cwd: dir,
    env: { ...process.env, BACKLENS_URL: `http://127.0.0.1:${sink.address().port}`, BACKLENS_ROOT: dir, BACKLENS_TOKEN: 't', NODE_OPTIONS: '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    const port = await new Promise((r) => child.once('message', r));
    for (const p of paths) await (await fetch(`http://127.0.0.1:${port}${p}`)).text();
    await new Promise((r) => setTimeout(r, 300));
    return traces;
  } finally {
    child.kill();
    sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('calls from bundled chunks point at the original source through the source map', async () => {
  const traces = await record(['/call']);
  const call = traces.find((t) => t.url === '/call');
  assert.ok(call, 'the request was recorded');
  const span = call.spans.find((s) => s.kind === 'http');
  assert.ok(span, 'the fetch was recorded');
  assert.deepEqual(span.frames[0], { fn: 'handler', file: 'src/app.ts', line: 10 });
});

test('framework asset requests are not recorded', async () => {
  const traces = await record(['/_next/static/chunks/a.js', '/favicon.ico', '/app.js.map', '/ping']);
  assert.deepEqual(traces.map((t) => t.url), ['/ping']);
});

test('outgoing http.get is recorded once with its status, and fetch is not counted twice', async () => {
  const app = `const http = require('node:http');
const server = http.createServer(async (req, res) => {
  const base = 'http://127.0.0.1:' + server.address().port;
  if (req.url.startsWith('/ping')) return res.end('pong');
  await new Promise((ok) => http.get(base + '/ping?x=1', (r) => { r.resume(); r.on('end', ok); }));
  await (await fetch(base + '/ping')).text();
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/both'], { 'out.js': app }, 'out.js');
  const spans = traces.find((t) => t.url === '/both').spans.filter((s) => s.kind === 'http');
  assert.equal(spans.length, 2);
  assert.match(spans[0].name, /^GET 127\.0\.0\.1:\d+\/ping$/, 'no query string in the label');
  assert.equal(spans[0].status, 200);
  assert.deepEqual(spans[0].frames[0], { fn: '(anonymous)', file: 'out.js', line: 5 });
});

test('ESM named imports of node:http are recorded too', async () => {
  const app = `import { createServer, get } from 'node:http';
const server = createServer(async (req, res) => {
  if (req.url === '/ping') return res.end('pong');
  await new Promise((ok) => get('http://127.0.0.1:' + server.address().port + '/ping', (r) => { r.resume(); r.on('end', ok); }));
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/esm'], { 'esm.mjs': app }, 'esm.mjs');
  assert.equal(traces.find((t) => t.url === '/esm').spans.filter((s) => s.kind === 'http').length, 1);
});

test('node-redis commands are recorded through its queue, and AUTH never shows its argument', async () => {
  // The same shape as @redis/client's dist/lib/client/commands-queue.js.
  const queue = `class RedisCommandsQueue {
  addCommand(args) { return Promise.resolve(args[0] === 'GET' ? null : 'OK'); }
}
exports.default = RedisCommandsQueue;`;
  const app = `const http = require('node:http');
const Queue = require('./lib/commands-queue').default;
const q = new Queue();
const server = http.createServer(async (req, res) => {
  await q.addCommand(['AUTH', 'hunter2-password']);
  await q.addCommand(['GET', 'session:abc']);
  res.end('ok');
});
server.listen(0, () => process.send(server.address().port));`;
  const traces = await record(['/r'], { 'lib/commands-queue.js': queue, 'redis-app.js': app }, 'redis-app.js');
  const spans = traces.find((t) => t.url === '/r').spans;
  assert.deepEqual(spans.map((s) => s.name), ['AUTH', 'GET session:abc']);
  assert.equal(spans[1].hit, false);
  assert.ok(!JSON.stringify(traces).includes('hunter2'));
});
