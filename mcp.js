/**
 * backlens as an MCP server, over stdio, for AI editors (Claude Code, Cursor, Windsurf...).
 *
 * It does not record anything itself: it reads the dashboard already running for this project
 * (`npx backlens`), which leaves its port and token in .backlens/session.json. An agent can then
 * see what each request does, change the code, and replay the same request to check the change.
 *
 * The protocol is newline-delimited JSON-RPC 2.0 on stdin and stdout; nothing else may be written
 * to stdout. No dependencies, like the rest of backlens.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { agentUsage, usageText } from './agent-usage.js';
import { dirname, join, relative, resolve } from 'node:path';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo']);

// ---- finding the running dashboard ------------------------------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readSession(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (Number.isInteger(s.port) && typeof s.token === 'string' && Number.isInteger(s.pid) && alive(s.pid)) return { ...s, file };
  } catch {}
  return null;
}

/** The project's folder and the ones above it, then folders below it (a monorepo's apps/api). */
export function findSessions(cwd) {
  const found = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const s = readSession(join(dir, '.backlens', 'session.json'));
    if (s) found.push(s);
    if (dirname(dir) === dir) break;
  }
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.backlens')) continue;
      const sub = join(dir, e.name);
      if (e.name === '.backlens') {
        const s = readSession(join(sub, 'session.json'));
        if (s && !found.some((f) => f.file === s.file)) found.push(s);
      } else walk(sub, depth + 1);
    }
  };
  walk(resolve(cwd), 1);
  return found.sort((a, b) => b.startedAt - a.startedAt);
}

const NOT_RUNNING =
  'backlens is not running for this project. Start it in the server folder with `npx backlens` (it records the app while you or your tests use it), then try again.';

function api(session, method, path, body) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: session.port,
        method,
        path,
        headers: { 'x-backlens-token': session.token, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolvePromise(data);
          else reject(new Error((data && data.error) || `backlens answered ${res.statusCode}`));
        });
      },
    );
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('backlens did not answer in time.')));
    req.on('error', (err) => reject(new Error(err.code === 'ECONNREFUSED' ? NOT_RUNNING : err.message)));
    req.end(payload);
  });
}

// ---- formatting -------------------------------------------------------------------------

const ms = (v) => (v == null ? '-' : `${v} ms`);
const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
const at = (f) => (f ? `${f.file}:${f.line}` : '');
const indent = (text, pad = '    ') => String(text).split('\n').map((l) => pad + l).join('\n');

function issueText(i, n) {
  const lines = [`${n}. [${i.severity}] ${i.title}`, `   route: ${i.route}   seen in ${i.seen} of ${i.of} requests${i.cost ? `   ~${i.cost} ms lost each time` : ''}`];
  if (i.sites && i.sites.length) lines.push(`   code: ${i.sites.join(' -> ')}`);
  if (i.sql) lines.push(`   calls:\n${indent(i.sql, '     ')}`);
  if (i.fix) lines.push(`   fix: ${i.fix}`);
  lines.push(`   example request: ${i.example}`);
  return lines.join('\n');
}

function spanText(s) {
  const where = s.frames && s.frames.length ? `  <- ${s.frames.slice(0, 3).map(at).join(' <- ')}` : '';
  const extra = [s.status != null ? `status ${s.status}` : '', s.rows != null ? `${plural(s.rows, 'row')}` : '', s.hit != null ? (s.hit ? 'hit' : 'miss') : '', s.error ? 'ERROR' : '']
    .filter(Boolean)
    .join(', ');
  return `  +${String(s.start).padStart(7)} ms  ${String(s.duration).padStart(7)} ms  ${s.kind.padEnd(5)} ${s.name}${extra ? `  (${extra})` : ''}${where}`;
}

function traceText(trace, issues) {
  const count = (kind) => trace.spans.filter((s) => s.kind === kind).length;
  const out = [
    `${trace.method} ${trace.url}  (route ${trace.route})`,
    `status ${trace.status}, ${ms(trace.duration)}, ${plural(count('db'), 'query')}, ${count('redis')} redis, ${count('http')} http out`,
    '',
    '  start        took        kind  call  <- code',
    ...trace.spans.map(spanText),
  ];
  if (issues && issues.length) out.push('', 'Issues in this request:', ...issues.map((i, n) => `${n + 1}. ${i.title}${i.sites && i.sites.length ? `  (${i.sites.join(' -> ')})` : ''}`));
  return out.join('\n');
}

// ---- tools ------------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'status',
    description: 'Whether backlens is recording this project, the app state, and how much traffic and how many issues it has seen. Call this first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_issues',
    description:
      'Performance issues found in real requests to the app, worst first: N+1 queries, the same call made twice in one request, independent calls awaited one after another, and missing Postgres indexes. Each has the route, the file:line behind it, the statements involved, a suggested fix and an example request id.',
    inputSchema: { type: 'object', properties: { route: { type: 'string', description: 'Only issues on this route, like "GET /v1/reviews".' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_routes',
    description: 'Every route of the app with calls, p50 and p95 time, and database, Redis and outgoing HTTP calls per request.',
    inputSchema: { type: 'object', properties: { include_uncalled: { type: 'boolean', description: 'Also list routes the app registered that nobody has called yet.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_requests',
    description: 'Recent requests the app served, newest first, with their ids for get_request and measure_request.',
    inputSchema: {
      type: 'object',
      properties: { route: { type: 'string', description: 'Only requests on this route, like "GET /v1/reviews".' }, limit: { type: 'number', description: 'How many (default 20, at most 100).' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_request',
    description:
      'One recorded request as a waterfall: every SQL query, Redis command and outgoing HTTP call in order, with timing and the file:line of the code that made it, plus the issues in it. Parameter values are never recorded.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'measure_request',
    description:
      'Replays a recorded read request (GET) against the app as it runs now, a few warm-up runs and then measured runs, and compares it with what was recorded earlier: median time, query count, and which issues are still there. Use it after changing code to check the change actually helped. Writes are never replayed.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'A request id from list_requests or an issue.' }, runs: { type: 'number', description: 'Measured runs (default 5, at most 20).' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'measure_url',
    description:
      'Sends a plain GET to a path on the running app (no cookies, no headers), a few warm-up runs and then measured runs, and compares it with requests recorded earlier on the same route. For public routes, or when there is no recorded request to replay. Call it before changing code too, so there is a before to compare with.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A path on the app, like "/v1/reviews?page=2".' }, runs: { type: 'number', description: 'Measured runs (default 5, at most 20).' } },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'app_logs',
    description: "The app's recent output (stdout and stderr), as backlens runs it.",
    inputSchema: { type: 'object', properties: { lines: { type: 'number', description: 'How many lines (default 80, at most 400).' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'restart_app',
    description: 'Restarts the app (or starts it if stopped) and waits until it listens again. backlens may already restart it on file changes.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'run_tests',
    description:
      "Runs the project's test script with recording on and waits for it: the exit code, how many requests the tests made, and the issues found in that traffic (new ones are not in backlens.baseline.json).",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'usage',
    description:
      'What this work cost in Claude Code: tokens and dollars for the current prompt, the session and the last 30 days of prompts that used backlens, and an estimate of what finding the same issues by reading code would take. Call it last, and end your report with its first line.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

const sleep = (t) => new Promise((r) => setTimeout(r, t));

async function call(name, args, cwd) {
  const sessions = findSessions(cwd);
  const session = sessions[0];
  // Read from Claude Code's own logs, so it works with the dashboard closed too.
  if (name === 'usage') return usageText(await agentUsage({ root: session ? session.root : cwd }), { current: true });
  if (!session) throw new Error(NOT_RUNNING);
  const where = relative(cwd, session.root) || '.';

  if (name === 'status') {
    const [state, appInfo, config] = await Promise.all([api(session, 'GET', '/api/state'), api(session, 'GET', '/api/app?since=999999999'), api(session, 'GET', '/api/config')]);
    const lines = [
      `backlens ${VERSION} is recording ${config.project || 'the app'} in ${where} (dashboard http://localhost:${session.port}).`,
      `app: ${appInfo.status}${appInfo.port ? ` on :${appInfo.port}` : ''}${appInfo.command ? `, ${appInfo.command}` : ''}`,
      `recorded: ${plural(state.total, 'request')} on ${state.routes.filter((r) => r.calls).length} of ${state.routes.length} routes`,
      `issues: ${state.issues.length}${state.issues.length ? ` (${state.issues.filter((i) => i.severity === 'warn').length} worth fixing first)` : ''}`,
      `tests: ${config.config && config.config.test ? `\`${config.config.test}\` script` : 'no test script picked'}`,
    ];
    if (!state.total) lines.push('', 'Nothing recorded yet: use the app (or run the tests) so backlens sees real requests.');
    if (sessions.length > 1) lines.push('', `Other backlens sessions: ${sessions.slice(1).map((s) => relative(cwd, s.root) || '.').join(', ')} (using the newest).`);
    return lines.join('\n');
  }

  if (name === 'list_issues') {
    const { issues, total } = await api(session, 'GET', '/api/state');
    const pick = (all) => (args.route ? all.filter((i) => i.route === args.route) : all);
    const list = pick(issues);
    if (list.length) return `${plural(list.length, 'issue')} in app traffic, worst first:\n\n${list.map((i, n) => issueText(i, n + 1)).join('\n\n')}`;
    // No app traffic with issues: the last test run's traffic is the next best thing.
    const { report } = await api(session, 'GET', '/api/tests?since=999999999');
    const fromTests = report ? pick(report.issues) : [];
    if (fromTests.length)
      return `${plural(fromTests.length, 'issue')} in the last test run's traffic (${plural(report.requests, 'request')}), worst first. Their example requests came from tests: get_request reads them; measure_request needs a request recorded from the running app.\n\n${fromTests.map((i, n) => `${issueText(i, n + 1)}${i.isNew ? '\n   new: not in backlens.baseline.json' : ''}`).join('\n\n')}`;
    if (total || report) return `No issues${args.route ? ` on ${args.route}` : ''} in ${plural(total, 'recorded request')}${report ? ` or in the last test run (${plural(report.requests, 'request')})` : ''}.`;
    return 'Nothing recorded yet: use the app, or call run_tests, so backlens sees real requests.';
  }

  if (name === 'list_routes') {
    const { routes } = await api(session, 'GET', '/api/state');
    const list = args.include_uncalled ? routes : routes.filter((r) => r.calls);
    if (!list.length) return 'No routes called yet.';
    return [
      'route | calls | p50 | p95 | queries/req | redis/req | http/req | 5xx | issues',
      ...list.map((r) => `${r.route} | ${r.calls} | ${ms(r.p50)} | ${ms(r.p95)} | ${r.queries} | ${r.redis} | ${r.http} | ${r.errors} | ${r.issues}`),
    ].join('\n');
  }

  if (name === 'list_requests') {
    const { recent } = await api(session, 'GET', '/api/state');
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
    const list = (args.route ? recent.filter((r) => r.route === args.route) : recent).slice(0, limit);
    if (!list.length) return 'No requests recorded yet.';
    return list.map((r) => `${r.id}  ${r.method} ${r.url}  ${r.status}  ${ms(r.duration)}  ${plural(r.spans, 'call')}${r.afterFix ? '  (after a kept fix)' : ''}`).join('\n');
  }

  if (name === 'get_request') {
    if (typeof args.id !== 'string' || !/^[\w-]{1,80}$/.test(args.id)) throw new Error('Give a request id from list_requests.');
    const { trace, issues } = await api(session, 'GET', `/api/trace/${args.id}`).catch((err) => {
      throw new Error(err.message === 'gone' ? 'That request is no longer in memory (backlens keeps the last 1000).' : err.message);
    });
    return traceText(trace, issues);
  }

  if (name === 'measure_request' || name === 'measure_url') {
    if (name === 'measure_request' && typeof args.id !== 'string') throw new Error('Give a request id from list_requests.');
    if (name === 'measure_url' && typeof args.url !== 'string') throw new Error('Give a path on the app, like /v1/reviews.');
    const m = await api(session, 'POST', '/api/measure', name === 'measure_url' ? { url: args.url, runs: args.runs } : { id: args.id, runs: args.runs });
    const row = (label, x) => (x ? `${label.padEnd(18)} ${ms(x.ms).padStart(10)}   ${String(x.queries).padStart(3)} queries  ${String(x.redis).padStart(3)} redis  ${String(x.http).padStart(3)} http   status ${x.status}   (${plural(x.runs, 'run')})` : `${label.padEnd(18)} none recorded`);
    const out = [`${m.route}${name === 'measure_url' ? `  (plain GET ${args.url}, no cookies)` : ''}`, '', row('recorded earlier', m.recorded), row('now (median)', m.now)];
    if (m.recorded && m.recorded.ms && m.now.ms != null) {
      const pct = Math.round(((m.now.ms - m.recorded.ms) / m.recorded.ms) * 100);
      out.push(`${''.padEnd(18)} ${`${pct > 0 ? '+' : ''}${pct}%`.padStart(10)}   ${m.now.queries - m.recorded.queries >= 0 ? '+' : ''}${m.now.queries - m.recorded.queries} queries`);
    }
    out.push('', m.issues.length ? `Issues still in the replayed request:\n${m.issues.map((i, n) => `${n + 1}. ${i.title}${i.sites && i.sites.length ? `  (${i.sites.join(' -> ')})` : ''}`).join('\n')}` : 'No issues in the replayed request.');
    out.push('', 'Timings on a dev machine move by a few ms between runs; query counts are exact.', '', 'Last replay:', traceText(m.trace));
    return out.join('\n');
  }

  if (name === 'app_logs') {
    const info = await api(session, 'GET', '/api/app?since=0');
    const n = Math.min(400, Math.max(1, Number(args.lines) || 80));
    const lines = info.lines.slice(-n).map((l) => l.text);
    return `app: ${info.status}${info.port ? ` on :${info.port}` : ''}\n\n${lines.join('\n') || '(no output yet)'}`;
  }

  if (name === 'restart_app') {
    const before = await api(session, 'GET', '/api/app?since=999999999');
    await api(session, 'POST', '/api/app/restart');
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const info = await api(session, 'GET', '/api/app?since=0');
      if (info.port && info.status === 'running' && (info.startedAt !== before.startedAt || i > 8)) return `The app is running on :${info.port}.`;
      if (['crashed', 'exited'].includes(info.status) && i > 4) return `The app ${info.status}. Last output:\n\n${info.lines.slice(-30).map((l) => l.text).join('\n')}`;
    }
    return 'The app did not report a port within 60 s. Check app_logs.';
  }

  if (name === 'run_tests') {
    await api(session, 'POST', '/api/tests/run');
    for (let i = 0; i < 1200; i++) {
      await sleep(500);
      const t = await api(session, 'GET', '/api/tests?since=0');
      if (t.status !== 'running' && t.report) {
        const r = t.report;
        const out = [
          `tests ${r.exitCode === 0 ? 'passed' : `failed (exit ${r.exitCode})`}: ${plural(r.requests, 'request')} to the app, ${plural(r.queries, 'query')}, ${r.routesCalled} of ${r.routesKnown} routes called`,
          `issues in test traffic: ${r.issues.length}, ${r.failing} new (not in backlens.baseline.json)`,
        ];
        if (r.issues.length) out.push('', ...r.issues.map((x, n) => `${issueText(x, n + 1)}${x.isNew ? '\n   new: not in backlens.baseline.json' : ''}`).join('\n\n').split('\n'));
        if (r.exitCode !== 0) out.push('', 'Test output (end):', ...t.lines.slice(-40).map((l) => l.text));
        return out.join('\n');
      }
    }
    return 'The tests are still running after 10 minutes. Check the dashboard.';
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---- JSON-RPC over stdio ----------------------------------------------------------------

export async function runMcp({ cwd = process.cwd(), args = [] } = {}) {
  // Editors that start servers outside the project can pass it: --root ${workspaceFolder}.
  const r = args.indexOf('--root');
  if (r !== -1 && args[r + 1]) cwd = resolve(args[r + 1]);
  const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'backlens', version: VERSION },
        instructions:
          'backlens records what each request to the local app does (SQL, Redis, outgoing HTTP, with the code line behind each call) and finds N+1 queries, repeated calls, serial awaits and missing indexes. Typical loop: status, list_issues, get_request on the example; measure the request BEFORE changing code (measure_request on a request recorded from the app, or measure_url for a public route), change the code (backlens restarts the app on file changes), measure the same thing again to confirm the issue is gone and it got faster, then run_tests. Requests from run_tests can be read with get_request but not replayed: measure_url, or a page opened in the app, gives something to replay. When you finish, call usage and end your report with its first line, so the user sees what the work cost.',
      });
    }
    if (method === 'ping') return isRequest && reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
      try {
        const text = await call(name, (params && params.arguments) || {}, cwd);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: err.message }], isError: true });
      }
    }
    if (method === 'resources/list') return reply(id, { resources: [] });
    if (method === 'prompts/list') return reply(id, { prompts: [] });
    if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
  }

  let buffer = '';
  let pending = 0;
  let ended = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(null, -32700, 'Parse error');
        continue;
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) {
        pending++;
        handle(m)
          .catch((err) => m.id != null && fail(m.id, -32603, err.message))
          .finally(() => {
            pending--;
            if (ended && !pending) process.exit(0);
          });
      }
    }
  });
  // The editor closed the pipe: answer what is still running, then stop.
  process.stdin.on('end', () => {
    ended = true;
    if (!pending) process.exit(0);
  });
  if (!existsSync(cwd)) process.stderr.write(`backlens mcp: ${cwd} does not exist\n`);
}
