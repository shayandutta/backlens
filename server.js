import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTrace, mapOf, routeOf, summarize } from './analyze.js';
import { loadConfig, packageManager, readProject, saveConfig, scriptCommand } from './config.js';
import { judge, stableKey } from './report.js';
import { Runner } from './runner.js';
import { createAI } from './ai/fixes.js';

const KEEP = 1000;
const KEEP_TEST = 5000;
const MAX_BODY = 4 * 1024 * 1024;
const REGISTER = fileURLToPath(new URL('./register.cjs', import.meta.url));
// Changes here never restart the app: dependencies, build output, backlens's own files.
const IGNORED = /(^|[/\\])(node_modules|\.git|\.backlens|dist|build|coverage|\.next|\.turbo)([/\\]|$)/;

/**
 * The dashboard, the endpoints the app reports to, and, in studio mode, the app and test
 * processes themselves. Listens on 127.0.0.1 only. Every request must name this host (so a
 * DNS-rebinding page cannot reach it) and carry the session token, and browser requests must
 * come from the dashboard's own origin. Only package.json scripts, by name, are ever run.
 */
export function startServer({ port, root = process.cwd(), token, manualArgv = null, mirror = null }) {
  const snapshotDir = join(root, '.backlens', 'snapshots');
  const baselineFile = join(root, 'backlens.baseline.json');
  const ui = new URL('./ui.html', import.meta.url);
  const pm = packageManager(root);
  let config = manualArgv ? { app: null, test: null, autoRestart: false } : loadConfig(root);

  const traces = [];
  // Issue key -> when its fix was kept (see summarize).
  const fixedAt = new Map();
  // Issue key -> the index created for it from the dashboard, so Undo still knows it.
  const createdIndexes = new Map();

  /** Sends one command to the recorder inside the app (see register.cjs). */
  function appCommand(port, body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const r = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/__backlens/index', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-backlens-token': token } },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let out = null;
            try {
              out = JSON.parse(raw);
            } catch {}
            if (res.statusCode === 200 && out) resolve(out);
            else reject(new Error((out && out.error) || 'The app did not answer. Is it running with backlens?'));
          });
        },
      );
      r.setTimeout(10 * 60 * 1000, () => r.destroy(new Error('Creating the index took over 10 minutes.')));
      r.on('error', (err) => reject(new Error(`Could not reach the app: ${err.message}`)));
      r.end(payload);
    });
  }
  let received = 0;
  const known = new Map();
  const advice = new Map();
  const testRun = { traces: [], report: null };
  const replays = new Map();
  let ai = null;

  let app = null;
  let tests = null;
  let watcher = null;
  // A fix being applied, checked or reverted restarts the app itself; file-change restarts would race it.
  let watchPaused = false;
  let actualPort = port;

  const tokenBuf = Buffer.from(token);
  const tokenOk = (value) => typeof value === 'string' && value.length === token.length && timingSafeEqual(Buffer.from(value), tokenBuf);
  const hostOk = (host) => [`localhost:${actualPort}`, `127.0.0.1:${actualPort}`, `[::1]:${actualPort}`].includes(host);
  const originOk = (origin) => !origin || origin === `http://localhost:${actualPort}` || origin === `http://127.0.0.1:${actualPort}`;

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });

  const childEnv = (source) => ({
    ...process.env,
    // Source maps, so file:line points at your TypeScript, not the compiled output.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --enable-source-maps --require ${JSON.stringify(REGISTER)}`.trim(),
    BACKLENS_URL: `http://127.0.0.1:${actualPort}`,
    BACKLENS_TOKEN: token,
    BACKLENS_ROOT: root,
    BACKLENS_SOURCE: source,
  });

  // ---- the app and the tests --------------------------------------------------------
  function appArgv() {
    if (manualArgv) return manualArgv;
    const { scripts } = readProject(root);
    return config && config.app && scripts[config.app] ? scriptCommand(pm, config.app) : null;
  }

  function startApp() {
    const argv = appArgv();
    if (!argv || app.child) return false;
    app.start(argv, root);
    return true;
  }

  function watchFiles() {
    if (watcher) watcher.close();
    watcher = null;
    if (!config || !config.autoRestart) return;
    let timer = null;
    try {
      watcher = watch(root, { recursive: true }, (_event, file) => {
        if (!file || IGNORED.test(file) || !app.argv || watchPaused) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          app.push(`${file} changed, restarting`, 'sys');
          app.restart();
        }, 400);
      });
    } catch {
      app.push('auto-restart is not available on this system', 'sys');
    }
  }

  function testReport() {
    let baseline = new Set();
    try {
      const data = JSON.parse(readFileSync(baselineFile, 'utf8'));
      baseline = new Set((data.issues ?? []).map((i) => i.key));
    } catch {}
    const result = judge(testRun.traces, [...known.keys()], baseline, { advice: [...advice.values()] });
    const calls = (kind) => testRun.traces.reduce((n, t) => n + t.spans.filter((s) => s.kind === kind).length, 0);
    return {
      requests: testRun.traces.length,
      queries: calls('db'),
      redis: calls('redis'),
      routesCalled: result.routes.filter((r) => r.calls).length,
      routesKnown: result.routes.length,
      exitCode: tests.exitCode,
      issues: result.issues.map((i) => ({ ...i, stableKey: stableKey(i) })),
      failing: result.failing.length,
    };
  }

  function acceptIntoBaseline(keys) {
    let existing = [];
    try {
      existing = JSON.parse(readFileSync(baselineFile, 'utf8')).issues ?? [];
    } catch {}
    const have = new Set(existing.map((i) => i.key));
    const report = testRun.report || testReport();
    for (const i of report.issues) {
      if (!keys.includes(i.stableKey) || have.has(i.stableKey)) continue;
      existing.push({ key: i.stableKey, title: i.title, route: i.route, sites: i.sites });
      have.add(i.stableKey);
    }
    writeFileSync(
      baselineFile,
      `${JSON.stringify({ note: 'Known issues backlens will not fail the build on. Commit this file.', issues: existing }, null, 2)}\n`,
    );
    testRun.report = testReport();
  }

  // ---- requests ----------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    if (!hostOk(req.headers.host)) return json(res, 403, { error: 'wrong host' });
    if (!originOk(req.headers.origin)) return json(res, 403, { error: 'wrong origin' });
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      return res.end(readFileSync(ui));
    }
    if (!tokenOk(req.headers['x-backlens-token'])) return json(res, 401, { error: 'Open the link backlens printed in your terminal.' });

    // From the app and test processes.
    if (req.method === 'POST' && url.pathname === '/ingest') {
      const trace = await readJson(req);
      if (trace && typeof trace.id === 'string' && Array.isArray(trace.spans)) {
        const replay = trace.replay;
        delete trace.replay;
        if (trace.replayOf) {
          // A fix being checked: hand it to the verifier, keep it out of the normal numbers.
          if (ai) ai.onReplayTrace(trace);
          return res.writeHead(204).end();
        }
        if (trace.source === 'test') {
          testRun.traces.push(trace);
          if (testRun.traces.length > KEEP_TEST) testRun.traces.shift();
        } else {
          traces.push(trace);
          received++;
          if (replay && !replay.truncated && ai && ai.replayEnabled()) replays.set(trace.id, replay);
          if (traces.length > KEEP) replays.delete(traces.shift().id);
        }
      }
      return res.writeHead(204).end();
    }
    if (req.method === 'POST' && url.pathname === '/advice') {
      const a = await readJson(req);
      if (a && typeof a.sql === 'string' && typeof a.table === 'string' && Array.isArray(a.columns)) advice.set(`${a.sql}|${a.table}`, a);
      return res.writeHead(204).end();
    }
    if (req.method === 'POST' && url.pathname === '/routes') {
      const body = await readJson(req);
      for (const r of (body && body.routes) || []) if (typeof r.method === 'string' && typeof r.path === 'string') known.set(`${r.method} ${r.path}`, r);
      return res.writeHead(204).end();
    }
    if (req.method === 'POST' && url.pathname === '/listening') {
      const body = await readJson(req);
      if (body && body.source !== 'test' && app && !app.port && Number.isInteger(body.port)) app.port = body.port;
      return res.writeHead(204).end();
    }

    // From the dashboard.
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const { routes, issues } = summarize(traces, [...known.keys()], [...advice.values()], fixedAt);
      const recent = traces
        .slice(-300)
        .reverse()
        .map((t) => ({ id: t.id, at: t.at, method: t.method, url: t.url, route: routeOf(t.method, t.url, t.template), status: t.status, duration: t.duration, spans: t.spans.length, aborted: Boolean(t.aborted), afterFix: Boolean(t.afterFix) }));
      return json(res, 200, { routes, issues, recent, total: traces.length, received });
    }
    if (req.method === 'GET' && url.pathname === '/api/map') {
      const { issues } = summarize(traces, [...known.keys()], [...advice.values()], fixedAt);
      return json(res, 200, { ...mapOf(traces, issues), advice: [...advice.values()].map((a) => ({ table: a.table, columns: a.columns })) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/trace/')) {
      const id = url.pathname.slice(11);
      const trace = traces.find((t) => t.id === id) || testRun.traces.find((t) => t.id === id);
      if (!trace) return json(res, 404, { error: 'gone' });
      return json(res, 200, { trace: { ...trace, route: routeOf(trace.method, trace.url, trace.template) }, issues: checkTrace(trace) });
    }
    if (req.method === 'POST' && url.pathname === '/api/clear') {
      traces.length = 0;
      received = 0;
      advice.clear();
      fixedAt.clear();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/snapshot') {
      const name = (url.searchParams.get('name') || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (!name) return json(res, 400, { error: 'Give the snapshot a name.' });
      const { routes, issues } = summarize(traces, [...known.keys()], [...advice.values()], fixedAt);
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(join(snapshotDir, `${name}.json`), `${JSON.stringify({ name, at: Date.now(), requests: traces.length, routes: routes.filter((r) => r.calls), issues: issues.length }, null, 2)}\n`);
      return json(res, 200, { ok: true, name });
    }
    if (req.method === 'GET' && url.pathname === '/api/snapshots') {
      const list = existsSync(snapshotDir)
        ? readdirSync(snapshotDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
              try {
                return JSON.parse(readFileSync(join(snapshotDir, f), 'utf8'));
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .sort((a, b) => b.at - a.at)
        : [];
      return json(res, 200, { snapshots: list });
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const project = readProject(root);
      return json(res, 200, { project: project.name, root, pm, scripts: project.scripts, config, needsSetup: !manualArgv && !config, manual: manualArgv ? manualArgv.join(' ') : null });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      if (manualArgv) return json(res, 400, { error: 'This session runs a command you gave on the command line.' });
      const body = await readJson(req);
      const { scripts } = readProject(root);
      if (!body || typeof body.app !== 'string' || !scripts[body.app]) return json(res, 400, { error: 'Pick a script from package.json to start the app.' });
      if (body.test != null && !scripts[body.test]) return json(res, 400, { error: 'That test script is not in package.json.' });
      const appChanged = !config || config.app !== body.app;
      config = { app: body.app, test: body.test ?? null, autoRestart: Boolean(body.autoRestart) };
      saveConfig(root, config);
      watchFiles();
      if (appChanged) {
        await app.stop();
        startApp();
      } else if (!app.child) startApp();
      return json(res, 200, { ok: true, config });
    }
    if (req.method === 'GET' && url.pathname === '/api/app') {
      return json(res, 200, { ...app.snapshot(), lines: app.since(Number(url.searchParams.get('since') || 0)), canStart: Boolean(appArgv()), autoRestart: Boolean(config && config.autoRestart) });
    }
    if (req.method === 'POST' && url.pathname === '/api/app/start') return json(res, 200, { ok: startApp() });
    if (req.method === 'POST' && url.pathname === '/api/app/stop') {
      await app.stop();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/app/restart') {
      if (app.child) await app.restart();
      else startApp();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/tests') {
      return json(res, 200, { ...tests.snapshot(), script: config && config.test, lines: tests.since(Number(url.searchParams.get('since') || 0)), report: testRun.report });
    }
    if (req.method === 'POST' && url.pathname === '/api/tests/run') {
      if (!config || !config.test) return json(res, 400, { error: 'Pick a test script in setup first.' });
      if (tests.child) return json(res, 409, { error: 'Tests are already running.' });
      testRun.traces = [];
      testRun.report = null;
      tests.lines = [];
      tests.start(scriptCommand(pm, config.test), root);
      return json(res, 200, { ok: true });
    }
    // Creating a suggested index on the database the app is using, through the app itself.
    if (req.method === 'POST' && url.pathname.startsWith('/api/index/')) {
      const action = url.pathname.slice('/api/index/'.length);
      if (!['info', 'create', 'drop'].includes(action)) return json(res, 404, { error: 'not found' });
      if (!app || !app.port) return json(res, 409, { error: 'The app is not running. Start it first.' });
      const body = (await readJson(req)) || {};
      let index = null;
      if (action !== 'info') {
        const { issues } = summarize(traces, [...known.keys()], [...advice.values()]);
        const issue = issues.find((i) => i.key === body.key);
        index = issue && issue.index ? issue.index : createdIndexes.get(body.key);
        if (!index) return json(res, 404, { error: 'That suggestion is gone. Refresh the list.' });
      }
      try {
        const out = await appCommand(app.port, { action, ...(index || {}) });
        if (action === 'create') {
          createdIndexes.set(body.key, index);
          fixedAt.set(body.key, Date.now());
        }
        if (action === 'drop') {
          createdIndexes.delete(body.key);
          fixedAt.delete(body.key);
        }
        return json(res, 200, { ...out, index });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (url.pathname.startsWith('/api/ai/')) {
      try {
        const body = req.method === 'POST' ? (await readJson(req)) || {} : {};
        const p = url.pathname;
        if (req.method === 'GET' && p === '/api/ai/status') return json(res, 200, await ai.status());
        if (req.method === 'POST' && p === '/api/ai/settings') return json(res, 200, { settings: ai.saveSettings(body) });
        if (req.method === 'POST' && p === '/api/ai/key') return json(res, 200, await ai.setKey(body.key));
        if (req.method === 'POST' && p === '/api/ai/key/remove') return json(res, 200, await ai.forgetKey());
        if (req.method === 'POST' && p === '/api/ai/ollama/pull') return json(res, 200, await ai.pullModel(body.model));
        if (req.method === 'POST' && p === '/api/ai/ollama/stop') return json(res, 200, await ai.stopPullModel());
        if (req.method === 'POST' && p === '/api/ai/explain') return json(res, 200, await ai.explain(body.key));
        if (req.method === 'POST' && p === '/api/ai/fix') return json(res, 200, await ai.startFix(body.key));
        const m = p.match(/^\/api\/ai\/fix\/([0-9a-f-]{36})(?:\/(send|apply|keep|revert|escalate|stop))?$/);
        if (m && req.method === 'GET' && !m[2]) {
          const job = ai.getFix(m[1]);
          return job ? json(res, 200, job) : json(res, 404, { error: 'gone' });
        }
        if (m && req.method === 'POST' && m[2]) return json(res, 200, await ai[m[2]](m[1]));
        return json(res, 404, { error: 'not found' });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/baseline') {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.keys)) return json(res, 400, { error: 'keys missing' });
      acceptIntoBaseline(body.keys.filter((k) => typeof k === 'string'));
      return json(res, 200, { ok: true, report: testRun.report });
    }
    res.writeHead(404).end();
  });

  /** Everything recorded so far, for the command-line test report. */
  server.recorded = () => ({ traces, known: [...known.keys()], advice: [...advice.values()] });
  server.shutdown = async () => {
    if (watcher) watcher.close();
    await Promise.all([app && app.stop(), tests && tests.stop()]);
    server.close();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      app = new Runner({ env: childEnv('app'), mirror });
      tests = new Runner({ env: childEnv('test') });
      // Traces arrive as responses finish; give the last ones a moment before reporting.
      tests.onExit = () => setTimeout(() => (testRun.report = testReport()), 500);
      watchFiles();
      server.startApp = startApp;
      ai = createAI({
        root,
        pm,
        config: () => config,
        readProject: () => readProject(root),
        appCommand: () => (manualArgv ? manualArgv.join(' ') : config && config.app ? readProject(root).scripts[config.app] : null),
        appPort: () => app.port,
        pauseWatch: (on) => (watchPaused = on),
        testsTail: () => tests.lines.slice(-14).map((l) => l.text).join('\n'),
        getIssue: (key) => {
          const { issues } = summarize(traces, [...known.keys()], [...advice.values()], fixedAt);
          return issues.find((i) => i.key === key) || (testRun.report ? testRun.report.issues.find((i) => i.key === key) : null);
        },
        getTrace: (id) => traces.find((t) => t.id === id) || testRun.traces.find((t) => t.id === id),
        markFixed: (key, after) => {
          fixedAt.set(key, Date.now());
          if (after) {
            const { replayOf, ...trace } = after;
            traces.push({ ...trace, afterFix: true });
            received++;
            if (traces.length > KEEP) replays.delete(traces.shift().id);
          }
        },
        getReplay: (id) => replays.get(id),
        restartApp: async () => {
          app.port = null;
          if (app.child) await app.restart();
          else startApp();
          for (let i = 0; i < 240; i++) {
            if (app.port) return app.port;
            if (!app.child && i > 4) return null;
            await new Promise((r) => setTimeout(r, 250));
          }
          return null;
        },
        runTests: () =>
          new Promise((done) => {
            if (!config || !config.test) return done(null);
            const run = () => {
              testRun.traces = [];
              testRun.report = null;
              tests.lines = [];
              tests.onExit = () =>
                setTimeout(() => {
                  testRun.report = testReport();
                  tests.onExit = () => setTimeout(() => (testRun.report = testReport()), 500);
                  done(testRun.report);
                }, 500);
              tests.start(scriptCommand(pm, config.test), root);
            };
            if (tests.child) tests.child.once('exit', () => setTimeout(run, 600));
            else run();
          }),
      });
      resolve(server);
    });
  });
}
