import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readProject, scriptCommand } from '../shared/project.js';
import { Runner } from './runner.js';
import { buildTestReport } from './test-report.js';

const RECORDER = fileURLToPath(new URL('../recorder/index.cjs', import.meta.url));
// Changes here never restart the app: dependencies, build output, backlens's own files.
const IGNORED = /(^|[/\\])(node_modules|\.git|\.backlens|dist|build|coverage|\.next|\.turbo)([/\\]|$)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment that turns the recorder on inside a child process and points it at this dashboard. */
export function recorderEnv({ port, token, root, source }) {
  return {
    ...process.env,
    // Source maps, so file:line points at your TypeScript, not the compiled output.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --enable-source-maps --require ${JSON.stringify(RECORDER)}`.trim(),
    BACKLENS_URL: `http://127.0.0.1:${port}`,
    BACKLENS_TOKEN: token,
    BACKLENS_ROOT: root,
    ...(source ? { BACKLENS_SOURCE: source } : {}),
  };
}

/**
 * The app and the test processes, run with the recorder inside. Only package.json scripts, by name,
 * are ever run (or the exact command given on the command line).
 *
 * getConfig(): the project's config ({ app, test, autoRestart }) or null.
 */
export function createProcesses({ root, pm, port, token, manualArgv, mirror, store, getConfig, baselineFile }) {
  const app = new Runner({ env: recorderEnv({ port, token, root, source: 'app' }), mirror });
  const tests = new Runner({ env: recorderEnv({ port, token, root, source: 'test' }) });
  let watcher = null;
  // A fix being applied, checked or reverted restarts the app itself; file-change restarts would race it.
  let watchPaused = false;

  const testReport = () => buildTestReport(store, tests.exitCode, baselineFile);
  // Traces arrive as responses finish; give the last ones a moment before reporting.
  const reportOnExit = () => setTimeout(() => (store.testRun.report = testReport()), 500);
  tests.onExit = reportOnExit;

  function appArgv() {
    if (manualArgv) return manualArgv;
    const config = getConfig();
    const { scripts } = readProject(root);
    return config && config.app && scripts[config.app] ? scriptCommand(pm, config.app) : null;
  }

  /** The command line behind the app, for telling whether it runs built output. */
  function appCommand() {
    if (manualArgv) return manualArgv.join(' ');
    const config = getConfig();
    return config && config.app ? readProject(root).scripts[config.app] : null;
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
    const config = getConfig();
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

  /** Restarts (or starts) the app and resolves with its port once it listens, or null. */
  async function restartApp() {
    app.port = null;
    if (app.child) await app.restart();
    else startApp();
    for (let i = 0; i < 240; i++) {
      if (app.port) return app.port;
      if (!app.child && i > 4) return null;
      await sleep(250);
    }
    return null;
  }

  /** Waits up to a minute for a running app to report its port. */
  async function appPort() {
    let p = app.port;
    for (let i = 0; !p && app.child && i < 240; i++) {
      await sleep(250);
      p = app.port;
    }
    return p;
  }

  function startTests() {
    const config = getConfig();
    store.testRun.traces = [];
    store.testReplays.clear();
    store.testRun.report = null;
    tests.lines = [];
    tests.start(scriptCommand(pm, config.test), root);
  }

  /** Runs the test script (waiting for a run in progress first) and resolves with its report. */
  function runTests() {
    return new Promise((done) => {
      const config = getConfig();
      if (!config || !config.test) return done(null);
      const run = () => {
        tests.onExit = () =>
          setTimeout(() => {
            store.testRun.report = testReport();
            tests.onExit = reportOnExit;
            done(store.testRun.report);
          }, 500);
        startTests();
      };
      if (tests.child) tests.child.once('exit', () => setTimeout(run, 600));
      else run();
    });
  }

  async function shutdown() {
    if (watcher) watcher.close();
    await Promise.all([app.stop(), tests.stop()]);
  }

  return {
    app,
    tests,
    appArgv,
    appCommand,
    startApp,
    watchFiles,
    pauseWatch: (on) => (watchPaused = on),
    restartApp,
    appPort,
    startTests,
    runTests,
    testReport,
    shutdown,
  };
}
