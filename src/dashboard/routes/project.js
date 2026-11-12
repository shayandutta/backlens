import { readProject } from '../../shared/project.js';
import { VERSION } from '../../shared/version.js';
import { saveConfig } from '../../shared/project-config.js';
import { acceptIntoBaseline } from '../../report/index.js';
import { json, readJson } from '../http.js';

/** Setup (which scripts start the app and run the tests), the app process, the tests, the baseline. */
export default function projectRoutes({ root, pm, manualArgv, procs, store, baselineFile, getConfig, setConfig }) {
  return [
    {
      method: 'GET',
      path: '/api/config',
      handle(req, res) {
        const project = readProject(root);
        const config = getConfig();
        return json(res, 200, { version: VERSION, project: project.name, root, pm, scripts: project.scripts, config, needsSetup: !manualArgv && !config, manual: manualArgv ? manualArgv.join(' ') : null });
      },
    },
    {
      method: 'POST',
      path: '/api/config',
      async handle(req, res) {
        if (manualArgv) return json(res, 400, { error: 'This session runs a command you gave on the command line.' });
        const body = await readJson(req);
        const { scripts } = readProject(root);
        if (!body || typeof body.app !== 'string' || !scripts[body.app]) return json(res, 400, { error: 'Pick a script from package.json to start the app.' });
        if (body.test != null && !scripts[body.test]) return json(res, 400, { error: 'That test script is not in package.json.' });
        const previous = getConfig();
        const appChanged = !previous || previous.app !== body.app;
        const config = { app: body.app, test: body.test ?? null, autoRestart: Boolean(body.autoRestart) };
        setConfig(config);
        saveConfig(root, config);
        const p = procs();
        p.watchFiles();
        if (appChanged) {
          await p.app.stop();
          p.startApp();
        } else if (!p.app.child) p.startApp();
        return json(res, 200, { ok: true, config });
      },
    },
    {
      method: 'GET',
      path: '/api/app',
      handle(req, res, url) {
        const p = procs();
        const config = getConfig();
        return json(res, 200, { ...p.app.snapshot(), lines: p.app.since(Number(url.searchParams.get('since') || 0)), canStart: Boolean(p.appArgv()), autoRestart: Boolean(config && config.autoRestart) });
      },
    },
    { method: 'POST', path: '/api/app/start', handle: (req, res) => json(res, 200, { ok: procs().startApp() }) },
    {
      method: 'POST',
      path: '/api/app/stop',
      async handle(req, res) {
        await procs().app.stop();
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/app/restart',
      async handle(req, res) {
        const p = procs();
        if (p.app.child) await p.app.restart();
        else p.startApp();
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/tests',
      handle(req, res, url) {
        const { tests } = procs();
        const config = getConfig();
        return json(res, 200, { ...tests.snapshot(), script: config && config.test, lines: tests.since(Number(url.searchParams.get('since') || 0)), report: store.testRun.report });
      },
    },
    {
      method: 'POST',
      path: '/api/tests/run',
      handle(req, res) {
        const config = getConfig();
        const p = procs();
        if (!config || !config.test) return json(res, 400, { error: 'Pick a test script in setup first.' });
        if (p.tests.child) return json(res, 409, { error: 'Tests are already running.' });
        p.startTests();
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/baseline',
      async handle(req, res) {
        const body = await readJson(req);
        if (!body || !Array.isArray(body.keys)) return json(res, 400, { error: 'keys missing' });
        const report = store.testRun.report || procs().testReport();
        acceptIntoBaseline(baselineFile, report.issues, body.keys.filter((k) => typeof k === 'string'));
        store.testRun.report = procs().testReport();
        return json(res, 200, { ok: true, report: store.testRun.report });
      },
    },
  ];
}

