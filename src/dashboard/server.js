import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { projectEnv } from '../access/env.js';
import { createSessions } from '../access/login.js';
import { createProfiles } from '../access/profiles.js';
import { createAI } from '../ai/index.js';
import { packageManager, readProject } from '../shared/project.js';
import { loadConfig, projectDir } from '../shared/project-config.js';
import { createBehavior } from './behavior.js';
import { createFreshness } from './fresh.js';
import { accessChecks, json } from './http.js';
import { createProcesses } from './processes.js';
import { createReplayer } from './replay.js';
import accessRoutes from './routes/access.js';
import aiRoutes from './routes/ai.js';
import behaviorRoutes from './routes/behavior.js';
import indexRoutes from './routes/indexes.js';
import ingestRoutes from './routes/ingest.js';
import measureRoutes from './routes/measure.js';
import projectRoutes from './routes/project.js';
import trafficRoutes from './routes/traffic.js';
import { createStore } from './store.js';

const UI = new URL('./ui.html', import.meta.url);

/**
 * The dashboard: the page, the endpoints the app reports to, the API the page and `backlens mcp`
 * use, and, in studio mode, the app and test processes themselves.
 *
 * Listens on 127.0.0.1 only. Every request must name this host (so a DNS-rebinding page cannot
 * reach it) and carry the session token, and browser requests must come from the dashboard's own
 * origin. Only package.json scripts, by name, are ever run.
 *
 * Resolves with the http.Server, extended with startApp(), recorded() and shutdown().
 */
export function startServer({ port, root = process.cwd(), token, manualArgv = null, mirror = null }) {
  const pm = packageManager(root);
  let config = manualArgv ? { app: null, test: null, autoRestart: false } : loadConfig(root);
  let actualPort = port;
  let procs = null;
  let ai = null;

  const store = createStore();
  const replayer = createReplayer();
  const checks = accessChecks(token, () => actualPort);
  const ctx = {
    root,
    pm,
    token,
    manualArgv,
    store,
    replayer,
    baselineFile: join(root, 'backlens.baseline.json'),
    snapshotDir: join(projectDir(root), 'snapshots'),
    getConfig: () => config,
    setConfig: (next) => (config = next),
    // Both exist once the server listens: the child processes need its port.
    procs: () => procs,
    ai: () => ai,
  };
  ctx.fresh = createFreshness({ store, procs: ctx.procs });
  const profiles = createProfiles(root);
  ctx.access = { profiles, env: () => projectEnv(root), sessions: null };
  ctx.access.sessions = createSessions({ profiles, env: ctx.access.env, appPort: () => (procs ? procs.appPort() : null) });
  ctx.behavior = createBehavior({ root, store, replayer, fresh: ctx.fresh, access: ctx.access });
  const routes = [ingestRoutes, trafficRoutes, projectRoutes, measureRoutes, behaviorRoutes, accessRoutes, indexRoutes, aiRoutes].flatMap((make) => make(ctx));

  function match(req, pathname) {
    for (const r of routes) {
      if (r.method !== '*' && r.method !== req.method) continue;
      if (typeof r.path === 'string') {
        if (r.path === pathname) return { route: r, m: null };
      } else {
        const m = pathname.match(r.path);
        if (m) return { route: r, m };
      }
    }
    return null;
  }

  const server = http.createServer(async (req, res) => {
    if (!checks.hostOk(req.headers.host)) return json(res, 403, { error: 'wrong host' });
    if (!checks.originOk(req.headers.origin)) return json(res, 403, { error: 'wrong origin' });
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      return res.end(readFileSync(UI));
    }
    if (!checks.tokenOk(req.headers['x-backlens-token'])) return json(res, 401, { error: 'Open the link backlens printed in your terminal.' });
    const found = match(req, url.pathname);
    if (!found) return res.writeHead(404).end();
    try {
      return await found.route.handle(req, res, url, found.m);
    } catch (err) {
      // One failing handler must never take the dashboard (and the app it runs) down.
      process.stderr.write(`backlens: ${req.method} ${url.pathname} failed: ${(err && err.stack) || err}\n`);
      if (!res.headersSent) return json(res, 500, { error: `backlens hit an error: ${(err && err.message) || err}` });
      res.end();
    }
  });

  /** Everything recorded so far, for the command-line test report. */
  server.recorded = () => ({ traces: store.traces, known: store.knownRoutes(), advice: store.adviceList() });
  server.shutdown = async () => {
    if (procs) await procs.shutdown();
    server.close();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      procs = createProcesses({ root, pm, port: actualPort, token, manualArgv, mirror, store, getConfig: () => config, baselineFile: ctx.baselineFile });
      procs.watchFiles();
      server.startApp = procs.startApp;
      ai = createAI({
        root,
        pm,
        config: () => config,
        readProject: () => readProject(root),
        appCommand: procs.appCommand,
        appPort: () => procs.app.port,
        pauseWatch: procs.pauseWatch,
        testsTail: () => procs.tests.lines.slice(-14).map((l) => l.text).join('\n'),
        getIssue: (key) => {
          const { issues } = store.summary();
          return issues.find((i) => i.key === key) || (store.testRun.report ? store.testRun.report.issues.find((i) => i.key === key) : null);
        },
        getTrace: store.findTrace,
        routeTraces: store.routeTraces,
        markFixed: store.markFixed,
        getReplay: (id) => store.replays.get(id),
        restartApp: procs.restartApp,
        runTests: procs.runTests,
        replayer,
      });
      resolve(server);
    });
  });
}
