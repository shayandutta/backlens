import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSessions } from '../mcp.js';
import { startServer } from '../server.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'backlens.js');
const TOKEN = 'a'.repeat(32);

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-backlens-token': TOKEN } },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Speaks MCP to `backlens mcp` the way an editor does. */
function client(cwd) {
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  let next = 1;
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  return { rpc, tool, close: () => child.stdin.end() };
}

test('an editor can list issues and read a request through backlens mcp, without any values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-mcp-'));
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: ['node', '-e', ''] });
  const port = server.address().port;
  // The session the dashboard leaves for the MCP server, in a monorepo's app folder.
  mkdirSync(join(root, 'apps', 'api', '.backlens'), { recursive: true });
  writeFileSync(join(root, 'apps', 'api', '.backlens', 'session.json'), JSON.stringify({ port, token: TOKEN, pid: process.pid, root: join(root, 'apps', 'api'), startedAt: Date.now() }));
  const span = (n) => ({ kind: 'db', name: 'select "name" from "users" where "id" = $1', start: n, duration: 1, frames: [{ fn: 'list', file: 'src/reviews.ts', line: 47 }], params: `p${n}` });
  await post(port, '/ingest', { id: 'req-1', at: Date.now(), method: 'GET', url: '/v1/reviews', status: 200, duration: 9, spans: [1, 2, 3, 4].map(span) });

  const mcp = client(root);
  try {
    const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'backlens');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const { tools } = (await mcp.rpc('tools/list', {})).result;
    assert.ok(tools.some((t) => t.name === 'measure_request'));

    const issues = await mcp.tool('list_issues');
    assert.ok(!issues.isError, issues.content[0].text);
    assert.match(issues.content[0].text, /N\+1: one query ran 4 times/);
    assert.match(issues.content[0].text, /src\/reviews\.ts:47/);
    assert.match(issues.content[0].text, /example request: req-1/);

    const request = (await mcp.tool('get_request', { id: 'req-1' })).content[0].text;
    assert.match(request, /GET \/v1\/reviews/);
    assert.match(request, /4 queries/);
    assert.ok(!request.includes('p1'), 'parameter hashes stay inside backlens');

    const missing = await mcp.tool('measure_request', { id: 'nope' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No recorded request/);
  } finally {
    mcp.close();
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('sessions of backlens processes that are gone are ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-mcp-'));
  try {
    mkdirSync(join(root, '.backlens'));
    writeFileSync(join(root, '.backlens', 'session.json'), JSON.stringify({ port: 1, token: 't', pid: 2 ** 22 + 12345, root, startedAt: 1 }));
    assert.deepEqual(findSessions(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
