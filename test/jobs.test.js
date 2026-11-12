import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/dashboard/server.js';
import { api } from '../src/mcp/session.js';

const TOKEN = 'd'.repeat(32);
const ingest = (port, body) => fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-backlens-token': TOKEN }, body: JSON.stringify(body) });

test('a request links to the job runs it queued, and a job run back to its request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlens-jobs-'));
  const server = await startServer({ port: 0, root, token: TOKEN, manualArgv: [process.execPath, '-e', ''] });
  const port = server.address().port;
  const session = { port, token: TOKEN };
  try {
    const frames = [{ fn: 'signup', file: 'src/users.ts', line: 20 }];
    await ingest(port, { id: 'req-1', at: Date.now(), method: 'POST', url: '/users', status: 201, duration: 9, spans: [{ kind: 'job', name: 'ENQUEUE emails:welcome', start: 1, duration: 2, frames, job: { queue: 'emails', name: 'welcome', id: '7' } }] });
    const run = (id, attempt, status) => ingest(port, { id, at: Date.now(), method: 'JOB', url: '/emails/welcome', template: '/emails/welcome', status, duration: 30, job: { queue: 'emails', name: 'welcome', id: '7', attempt }, spans: [{ kind: 'db', name: 'select * from users where id = $1', start: 1, duration: 2, frames }] });
    await run('job-1', 0, 500);
    await run('job-2', 1, 200);
    const req = await api(session, 'GET', '/api/trace/req-1');
    assert.equal(req.jobs.length, 1);
    assert.deepEqual(req.jobs[0].runs.map((r) => [r.id, r.status, r.attempt, r.queries]), [['job-1', 500, 0, 1], ['job-2', 200, 1, 1]]);
    const job = await api(session, 'GET', '/api/trace/job-2');
    assert.deepEqual(job.queuedBy, { id: 'req-1', route: 'POST /users' });
    // Job runs are checked like requests: they show as their own route.
    const { routes } = await api(session, 'GET', '/api/state');
    assert.ok(routes.some((r) => r.route === 'JOB /emails/welcome'));
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
