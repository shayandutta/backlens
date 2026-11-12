import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The compatibility matrix's runner: real library versions, real Postgres and Redis. Each case is a
 * tiny app installed into its own folder (reused between runs, keyed by its dependencies), run
 * with the recorder, sent a few requests; the traces the recorder reports are returned.
 *
 * Needs PG_URL and REDIS_URL (CI sets them from service containers). Cases needing one that is
 * missing are skipped, never faked.
 */

const REGISTER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'recorder', 'index.cjs');
const ROOT = join(tmpdir(), 'backlens-compat');

export const env = { pg: process.env.PG_URL || null, redis: process.env.REDIS_URL || null };

/** Installs `deps` once into a folder named after them. */
function project(deps) {
  const key = Object.entries(deps)
    .map(([n, v]) => `${n}@${v}`)
    .join('+')
    .replace(/[^\w.@+-]/g, '_');
  const dir = join(ROOT, key);
  if (!existsSync(join(dir, 'node_modules'))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'compat-case', private: true, dependencies: deps }));
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', '--ignore-scripts'], { cwd: dir, stdio: 'inherit' });
  }
  return dir;
}

/**
 * Runs `app` (CommonJS source; it must listen on port 0 and process.send(port)) with the recorder,
 * requests each path in order, and returns { [path]: trace }.
 */
export async function run({ deps, app, paths }) {
  const all = await runWith({ deps, app, drive: async (port) => {
    for (const p of paths) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      await r.text();
    }
  } });
  const out = {};
  for (const t of all) if (!t.replayOf) out[t.url] = t;
  return out;
}

/** Like run(), but `drive(port)` sends whatever it wants; every trace reported is returned, replays included. */
export async function runWith({ deps, app, drive }) {
  const dir = project(deps);
  writeFileSync(join(dir, 'app.js'), app);
  const traces = [];
  const sink = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      if (req.url === '/ingest') traces.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--require', REGISTER, 'app.js'], {
    cwd: dir,
    env: { ...process.env, BACKLENS_URL: `http://127.0.0.1:${sink.address().port}`, BACKLENS_ROOT: dir, BACKLENS_TOKEN: 'compat', NODE_OPTIONS: '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', (code) => reject(new Error(`the app exited (${code}) before listening`)));
    });
    await drive(port);
    // Spans reported after the response (Prisma) and the trace itself arrive just after.
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    child.kill();
    sink.close();
  }
  return traces;
}

/** The recorded calls of one kind, as their names (lower-cased SQL, upper-cased Redis command + key). */
export const calls = (trace, kind) => (trace ? trace.spans.filter((s) => s.kind === kind).map((s) => (kind === 'db' ? s.name.trim().toLowerCase() : s.name)) : []);

/** True when every span of a kind points at a line in the app file. */
export const allAttributed = (trace, kind) => trace.spans.filter((s) => s.kind === kind).every((s) => s.frames && s.frames.some((f) => f.file === 'app.js'));
