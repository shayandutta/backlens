import { relative } from 'node:path';
import { agentUsage, usageText } from '../agent-usage/index.js';
import { acceptText, diffText } from '../diff/format.js';
import { readLedger } from '../evidence/ledger.js';
import { reportMarkdown } from '../evidence/report.js';
import { doctorText } from '../report/doctor.js';
import { mutationText } from '../mutate/format.js';
import { timingText } from '../shared/compare.js';
import { ago, issueText, ms, plural, traceText } from './format.js';
import { api, findSessions, NOT_RUNNING } from './session.js';
import { VERSION } from '../shared/version.js';

/** What each tool does: reads the running dashboard's API and answers in plain text. */

const sleep = (t) => new Promise((r) => setTimeout(r, t));
// The dashboard answers 409 with { error } for a diff that could not run: show that text.
const passError = (err) => ({ error: err.message });

export async function call(name, args, cwd) {
  const sessions = findSessions(cwd);
  const session = sessions[0];
  // Read from Claude Code's own logs, so it works with the dashboard closed too.
  if (name === 'usage') return usageText(await agentUsage({ root: session ? session.root : cwd }), { current: true });
  if (name === 'report') {
    const hours = Number(args.hours) || 24;
    return reportMarkdown(readLedger(session ? session.root : cwd, Date.now() - hours * 3600 * 1000), { hours });
  }
  if (!session) throw new Error(NOT_RUNNING);
  const where = relative(cwd, session.root) || '.';

  if (name === 'status') {
    const [state, appInfo, config, access, adapters] = await Promise.all([
      api(session, 'GET', '/api/state'),
      api(session, 'GET', '/api/app?since=999999999'),
      api(session, 'GET', '/api/config'),
      api(session, 'GET', '/api/access').catch(() => ({ profiles: [] })),
      api(session, 'GET', '/api/adapters').catch(() => ({ list: [] })),
    ]);
    // The recorder runs from the dashboard's package; this MCP server may be another install
    // (npx caches each version), and an older one misreads newer answers.
    const recorder = config.version || session.version || 'an older version (it does not report one)';
    const lines = [
      `backlens is recording ${config.project || 'the app'} in ${where} (dashboard http://localhost:${session.port}).`,
      `versions: recorder ${recorder}, MCP server ${VERSION}`,
      `app: ${appInfo.status}${appInfo.port ? ` on :${appInfo.port}` : ''}${appInfo.command ? `, ${appInfo.command}` : ''}`,
      `recorded: ${plural(state.total, 'request')} on ${state.routes.filter((r) => r.calls).length} of ${state.routes.length} routes`,
      `issues: ${state.issues.length}${state.issues.length ? ` (${state.issues.filter((i) => i.severity === 'warn').length} worth fixing first)` : ''}`,
      `tests: ${config.config && config.config.test ? `\`${config.config.test}\` script` : 'no test script picked'}`,
      `adapters: ${adapters.list.length ? adapters.list.map((a) => `${a.name}${a.package && a.version ? ` ${a.version}` : ''}${a.status === 'ok' ? '' : ` (${a.status})`}`).join(', ') : 'none reported yet'}${adapters.list.some((a) => a.status !== 'ok') ? ' - run doctor' : ''}`,
      `logins: ${access.profiles.length ? access.profiles.map((p) => `${p.name}${p.name === access.default ? ' (default)' : ''}${p.sessionOnly ? ' (this session)' : ''}`).join(', ') : 'none saved (save_login from a recorded sign-in request)'}`,
    ];
    if (recorder !== VERSION)
      lines.push(
        '',
        `Version mismatch: the recorder is ${recorder} and this MCP server is ${VERSION}. Run both from the same version: restart \`npx backlens@latest\` and re-add the MCP server with \`claude mcp add backlens -- npx -y backlens@latest mcp\`, then reconnect it.`,
      );
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
      return `${plural(fromTests.length, 'issue')} in the last test run's traffic (${plural(report.requests, 'request')}), worst first. Their example requests came from tests: get_request reads them, and measure_request replays them against the running app.\n\n${fromTests.map((i, n) => `${issueText(i, n + 1)}${i.isNew ? '\n   new: not in backlens.baseline.json' : ''}`).join('\n\n')}`;
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
    const { recent, tests = [] } = await api(session, 'GET', '/api/state');
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
    const from = args.from === 'tests' ? tests : recent;
    const list = (args.route ? from.filter((r) => r.route === args.route) : from).slice(0, limit);
    if (!list.length) return args.from === 'tests' ? 'No requests from a test run yet: call run_tests.' : 'No requests recorded yet.';
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
    const m = await api(session, 'POST', '/api/measure', name === 'measure_url' ? { url: args.url, runs: args.runs, as: args.as } : { id: args.id, runs: args.runs, as: args.as, sandbox: args.sandbox === true });
    const row = (label, x) =>
      x ? `${label.padEnd(20)} ${timingText(x).padStart(26)}   ${String(x.queries).padStart(3)} queries  ${String(x.redis).padStart(3)} redis  ${String(x.http).padStart(3)} http   status ${x.status}` : `${label.padEnd(20)} none`;
    const out = [`${m.route}${m.as ? `  (signed in as ${m.as})` : name === 'measure_url' ? `  (plain GET ${args.url}, no cookies)` : ''}`, '', `${''.padEnd(20)} ${'median (p25-p75, runs)'.padStart(26)}`];
    if (m.previous) {
      out.push(row('measured before', m.previous), row('now', m.now));
      const dq = m.now.queries - m.previous.queries;
      const time = m.change.verdict === 'same' ? `time: within noise (${m.change.delta > 0 ? '+' : ''}${m.change.delta} ms, the runs overlap)` : `time: ${m.change.verdict}, ${m.change.delta > 0 ? '+' : ''}${m.change.delta} ms (${m.change.pct > 0 ? '+' : ''}${m.change.pct}%), the runs do not overlap`;
      out.push('', `${time}; queries: ${dq === 0 ? 'same' : `${dq > 0 ? '+' : ''}${dq}`}${m.now.status !== m.previous.status ? `; status ${m.previous.status} -> ${m.now.status}` : ''}`);
      out.push(`Compared with the last warm measurement of this request (${ago(m.previous.at)}).`);
    } else {
      out.push(row('now', m.now));
      if (m.recorded) out.push(row('recorded traffic', m.recorded), '(recorded traffic includes cold requests, so it is not compared)');
      out.push('', 'First measurement of this request: saved. Change the code, then measure it again to compare warm against warm.');
    }
    if (m.writes && m.writes.length) out.push('', `Warning: this ${m.trace.method} changed data each time it was replayed (${m.writes.slice(0, 3).join(', ')}). Replaying it again changes it again.`);
    else if (m.redisWrites && m.redisWrites.length) out.push('', `It also wrote to Redis on each replay (${m.redisWrites.slice(0, 3).join(', ')}): usually a cache fill or rate limit.`);
    if (m.sandbox) {
      if (m.sandbox.contained) out.push('', `Sandbox: every run's ${m.sandbox.statements} Postgres statements were rolled back.${m.sandbox.redisWrites.length ? ` Not undone: Redis ${m.sandbox.redisWrites.join(', ')}.` : ''}`);
      else out.push('', `WARNING: the sandbox did not hold: ${m.sandbox.leaked ? `${m.sandbox.leaked} queries ran on a connection outside the transaction` : m.sandbox.error}. Writes may have reached the database.`);
    }
    if (m.otherStatuses) out.push('', `${m.otherStatuses.runs} of ${m.otherStatuses.of} runs answered ${m.otherStatuses.statuses.join(', ')} instead of ${m.now.status} and were left out${m.otherStatuses.statuses.includes(429) ? ' (rate limited)' : ''}.`);
    if (m.restarted) out.push('', 'backlens restarted the app first, so this run is measured fresh like the one it is compared with.');
    out.push('', m.issues.length ? `Issues still in the replayed request:\n${m.issues.map((i, n) => `${n + 1}. ${i.title}${i.sites && i.sites.length ? `  (${i.sites.join(' -> ')})` : ''}`).join('\n')}` : 'No issues in the replayed request.');
    out.push('', 'Query counts are exact. Times are local replays on this machine (warm medians, recording on), not production latency; a change counts only when it is at least 1 ms and the p25-p75 ranges do not overlap.', '', 'Last replay:', traceText(m.trace));
    return out.join('\n');
  }

  if (name === 'mutate') return mutationText(await api(session, 'POST', '/api/mutate', { max: args.max, tests: args.tests !== false }).catch((err) => ({ error: err.message })));
  if (name === 'doctor') return doctorText(await api(session, 'GET', '/api/doctor'));

  if (name === 'save_login') {
    const r = await api(session, 'POST', '/api/access/save', { name: args.name, id: args.id, default: args.default === true });
    const lines = [
      r.sessionOnly
        ? `Saved "${r.name}" for this session only: no .env variable holds its ${r.missing.join(', ')}, so it is kept in memory and never written. Put the value in .env and save again to keep it.`
        : `Saved "${r.name}" in ${relative(cwd, r.file) || r.file}; its secrets are references to .env variables, not values.`,
      r.signedIn ? `Signing in as ${r.name} works. Use as: "${r.name}" with measure_url, measure_request and diff.` : `Signing in did not work yet: ${r.why}`,
      `Profiles: ${r.profiles.map((p) => `${p.name}${p.name === r.default ? ' (default)' : ''}`).join(', ')}`,
    ];
    return lines.join('\n');
  }

  if (name === 'diff') return diffText(await api(session, 'POST', '/api/behavior/diff', { route: args.route, time: args.time === true }).catch(passError));
  if (name === 'accept') return acceptText(await api(session, 'POST', '/api/behavior/accept', Array.isArray(args.routes) ? { routes: args.routes } : {}).catch(passError));

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
