import { relative } from 'node:path';
import { agentUsage, usageText } from '../agent-usage/index.js';
import { issueText, ms, plural, traceText } from './format.js';
import { api, findSessions, NOT_RUNNING } from './session.js';
import { VERSION } from './version.js';

/** What each tool does: reads the running dashboard's API and answers in plain text. */

const sleep = (t) => new Promise((r) => setTimeout(r, t));

export async function call(name, args, cwd) {
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
