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
async function record(paths) {
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

  const traces = [];
  const sink = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      if (req.url === '/ingest') traces.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--require', REGISTER, 'server.js'], {
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
