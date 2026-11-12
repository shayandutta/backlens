import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';
import { doctorText } from '../src/report/doctor.js';

const REGISTER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'recorder', 'index.cjs');
const sleep = (t) => new Promise((r) => setTimeout(r, t));

/** A stand-in pg at `version`, its query optionally pre-wrapped like OpenTelemetry's shimmer does. */
const fakePg = (version, wrapped) => ({
  'node_modules/pg/package.json': JSON.stringify({ name: 'pg', version, main: 'index.js' }),
  'node_modules/pg/index.js': `class Client { query() { return Promise.resolve({ rows: [] }); } }
${wrapped ? 'const q = Client.prototype.query; Client.prototype.query = function () { return q.apply(this, arguments); }; Client.prototype.query.__wrapped = true;' : ''}
class Pool { query() { return Promise.resolve({ rows: [] }); } }
module.exports = { Pool, Client };`,
});

/** Runs an app that requires pg under the recorder and returns the adapters it reported. */
async function adaptersFor(files) {
  const dir = mkdtempSync(join(tmpdir(), 'backlens-adapters-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  writeFileSync(join(dir, 'app.js'), `require('pg'); require('node:http').createServer((q, s) => s.end()).listen(0, function () { process.send(this.address().port); });`);
  let reported = null;
  const sink = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      if (req.url === '/adapters') reported = JSON.parse(body).adapters;
      res.end('{}');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--require', REGISTER, 'app.js'], {
    cwd: dir,
    env: { ...process.env, BACKLENS_URL: `http://127.0.0.1:${sink.address().port}`, BACKLENS_ROOT: dir, BACKLENS_TOKEN: 't', NODE_OPTIONS: '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    await new Promise((r) => child.once('message', r));
    for (let i = 0; i < 40 && !reported; i++) await sleep(50);
  } finally {
    child.kill();
    sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return Object.fromEntries((reported || []).map((a) => [a.name, a]));
}

test('the recorder reports what it hooked into, with versions and status', async () => {
  const ok = await adaptersFor(fakePg('8.16.0', false));
  assert.equal(ok.pg.version, '8.16.0');
  assert.equal(ok.pg.status, 'ok');
  assert.equal(ok['http server'].status, 'ok');
  assert.ok(ok.fetch);

  const old = await adaptersFor(fakePg('7.18.2', false));
  assert.equal(old.pg.status, 'untested');
  assert.match(old.pg.why, /7\.18\.2 is not in the compatibility matrix \(tested: 8\.x\)/);

  const shared = await adaptersFor(fakePg('8.16.0', true));
  assert.equal(shared.pg.status, 'shared', 'methods another tool wrapped first are flagged');
});

test('doctor measures what recording costs, recording on vs off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-doctor-'));
  writeFileSync(join(root, 'package.json'), '{"name":"doctor-test"}');
  writeFileSync(join(root, 'app.js'), `require('node:http').createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"ok":true}'); }).listen(0);`);
  const TOKEN = 'f'.repeat(32);
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, 'app.js'] });
  server.startApp();
  const session = { port: server.address().port, token: TOKEN };
  try {
    let app;
    for (let i = 0; i < 80 && !(app && app.port); i++) {
      await sleep(100);
      app = await api(session, 'GET', '/api/app?since=999999999');
    }
    await fetch(`http://127.0.0.1:${app.port}/items`);
    await sleep(300);
    const d = await api(session, 'GET', '/api/doctor');
    assert.ok(d.recorderSeen);
    assert.ok(d.adapters.some((a) => a.name === 'http server'));
    assert.equal(d.overhead.length, 1);
    const o = d.overhead[0];
    assert.equal(o.route, 'GET /items');
    assert.ok(o.recording.runs >= 10 && o.bare.runs >= 10);
    assert.equal(typeof o.ms, 'number');
    // The doctor's own requests are not counted as app traffic.
    const { total } = await api(session, 'GET', '/api/state');
    assert.equal(total, 1);
    assert.match(doctorText(d), /Cost of recording/);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
