#!/usr/bin/env node
/**
 * The backlens eval (ROADMAP Phase 5): the same coding tasks, done by Claude Code with and without
 * backlens, on real apps. Per run it records tokens and cost (from `claude -p --output-format json`),
 * turns, whether the task's own check passed, and regressions shipped: routes the behavior diff
 * finds broken after the agent finished, against a baseline taken before it started.
 *
 *   node scripts/eval/run.mjs tasks.json [--arms with,without] [--only <task id>] [--out results.jsonl]
 *
 * tasks.json: see scripts/eval/README.md. Each run happens in a fresh `git worktree` of the app at the
 * task's ref, so the app's own checkout is never touched. backlens runs in both arms (to measure
 * regressions the same way); only the "with" arm gives the agent its MCP tools and stop hook.
 *
 * This spends model tokens (one agent session per task and arm). Nothing runs without the tasks
 * file you give it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, findSessions } from '../../src/mcp/session.js';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'backlens.js');
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

function sh(cmd, cwd, { timeoutMs = 10 * 60 * 1000, env = {} } = {}) {
  try {
    const out = execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, out };
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

/** Starts backlens for the app folder and waits until the app is up. Returns { stop, session }. */
async function startBacklens(appDir) {
  const child = spawn(process.execPath, [BIN, '--no-open'], { cwd: appDir, stdio: 'ignore', detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  };
  for (let i = 0; i < 480; i++) {
    await sleep(500);
    const session = findSessions(appDir)[0];
    if (!session) continue;
    try {
      const app = await api(session, 'GET', '/api/app?since=999999999');
      if (app.port && app.status === 'running') return { stop, session, port: app.port };
    } catch {}
  }
  stop();
  throw new Error('backlens or the app did not start within 4 minutes');
}

/** Claude Code with a prompt, headless. Returns its JSON result (tokens, cost, turns, text). */
function runAgent(task, dir, withBacklens) {
  const args = ['-p', task.prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--max-turns', String(task.maxTurns || 40)];
  if (task.model) args.push('--model', task.model);
  if (withBacklens) {
    const mcp = join(dir, '.eval-mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { backlens: { command: process.execPath, args: [BIN, 'mcp'] } } }));
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${BIN}" hook stop`, timeout: 90 }] }] }, permissions: { allow: ['mcp__backlens'] } };
    args.push('--mcp-config', mcp, '--strict-mcp-config', '--settings', JSON.stringify(settings));
  } else args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }));
  const allowed = task.allowedTools || ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];
  args.push('--allowedTools', ...allowed, ...(withBacklens ? ['mcp__backlens'] : []));
  const started = Date.now();
  const r = sh(['claude', ...args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`)].join(' '), dir, { timeoutMs: (task.timeoutMin || 30) * 60 * 1000 });
  let json = null;
  try {
    json = JSON.parse(r.out.trim().split('\n').filter(Boolean).at(-1));
  } catch {}
  return { ok: r.code === 0 && json && !json.is_error, ms: Date.now() - started, json, tail: json ? null : r.out.slice(-2000) };
}

async function runOne(task, arm) {
  const repo = resolve(task.repo);
  const wt = mkdtempSync(join(tmpdir(), `backlens-eval-${task.id}-${arm}-`));
  rmSync(wt, { recursive: true, force: true });
  sh(`git worktree add --detach '${wt}' '${task.ref || 'HEAD'}'`, repo);
  const appDir = join(wt, task.appDir || '.');
  const row = { task: task.id, arm, at: new Date().toISOString() };
  let bl = null;
  try {
    if (task.setup) {
      const s = sh(task.setup, wt, { timeoutMs: 20 * 60 * 1000 });
      if (s.code) throw new Error(`setup failed: ${s.out.slice(-500)}`);
    }
    if (task.backlensConfig) {
      mkdirSync(join(appDir, '.backlens'), { recursive: true });
      writeFileSync(join(appDir, '.backlens', 'config.json'), JSON.stringify(task.backlensConfig));
    }
    // Both arms: backlens records, and takes the baseline from the task's traffic script.
    bl = await startBacklens(appDir);
    if (task.traffic) sh(task.traffic, appDir, { env: { APP_PORT: String(bl.port) } });
    await sleep(500);
    const base = await api(bl.session, 'POST', '/api/behavior/diff', {});
    row.baselineRoutes = base.captured ? base.captured.length : 0;

    const agent = runAgent(task, wt, arm === 'with');
    const u = (agent.json && agent.json.usage) || {};
    Object.assign(row, {
      agentOk: agent.ok,
      ms: agent.ms,
      turns: agent.json ? agent.json.num_turns : null,
      costUsd: agent.json ? agent.json.total_cost_usd : null,
      tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 },
      agentError: agent.tail,
    });

    // Did the task get done? The task's own check (tests, a script), on the agent's tree.
    const check = task.check ? sh(task.check, wt, { timeoutMs: 20 * 60 * 1000 }) : { code: 0 };
    row.success = check.code === 0;
    if (check.code) row.checkTail = check.out.slice(-1500);

    // Regressions shipped: the behavior diff after the agent, against the baseline from before.
    const diff = await api(bl.session, 'POST', '/api/behavior/diff', {}).catch((e) => ({ error: e.message }));
    row.regressions = diff.error ? null : diff.broken;
    row.regressionRoutes = diff.results ? diff.results.filter((r) => r.findings.some((f) => f.kind === 'broken')).map((r) => r.route) : [];
    row.diffError = diff.error || null;
  } catch (err) {
    row.error = err.message;
  } finally {
    if (bl) bl.stop();
    await sleep(1500);
    sh(`git worktree remove --force '${wt}'`, repo);
  }
  return row;
}

function summary(rows) {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const lines = ['| arm | runs | success | regressions shipped | median tokens (in+out) | median cost | median turns |', '|---|---|---|---|---|---|---|'];
  const med = (xs) => {
    const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
    return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
  };
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm && !r.error);
    lines.push(
      `| ${arm} | ${rs.length} | ${rs.filter((r) => r.success).length}/${rs.length} | ${rs.reduce((n, r) => n + (r.regressions || 0), 0)} | ${med(rs.map((r) => r.tokens && r.tokens.input + r.tokens.output))} | ${med(rs.map((r) => r.costUsd)) ?? '-'} | ${med(rs.map((r) => r.turns)) ?? '-'} |`,
    );
  }
  return lines.join('\n');
}

const file = argv.find((a) => a.endsWith('.json'));
if (!file || !existsSync(file)) {
  process.stderr.write('usage: node scripts/eval/run.mjs tasks.json [--arms with,without] [--only <id>] [--out results.jsonl]\n');
  process.exit(1);
}
const tasks = JSON.parse(readFileSync(file, 'utf8')).tasks.filter((t) => !flag('--only') || t.id === flag('--only'));
const arms = (flag('--arms') || 'without,with').split(',');
const out = flag('--out') || 'eval-results.jsonl';
const rows = [];
for (const task of tasks) {
  for (const arm of arms) {
    process.stderr.write(`${task.id} / ${arm} ...\n`);
    const row = await runOne(task, arm);
    rows.push(row);
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    process.stderr.write(`  ${row.error ? `error: ${row.error}` : `success ${row.success}, regressions ${row.regressions}, ${row.turns} turns, $${row.costUsd}`}\n`);
  }
}
process.stdout.write(`${summary(rows)}\n`);
