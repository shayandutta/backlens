import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, findSessions } from '../mcp/session.js';

/**
 * `backlens init <claude|codex|cursor>`: connects a coding agent to backlens in this project.
 *
 *   claude  .claude/settings.json  Stop hook        .mcp.json         MCP server
 *   codex   .codex/hooks.json      Stop hook        (MCP: `codex mcp add`, printed)
 *   cursor  .cursor/hooks.json     stop hook        .cursor/mcp.json  MCP server
 *
 * Existing files are merged, never replaced; a file that is not valid JSON is left alone and the
 * command stops. `--uninstall` removes exactly what this added. `--local` points the hook at this
 * copy of backlens instead of `npx backlens@latest` (for developing backlens itself).
 */

const HOOK_TIMEOUT_S = 90;
const MCP_ENTRY = { command: 'npx', args: ['-y', 'backlens@latest', 'mcp'] };
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'backlens.js');
export const HARNESSES = ['claude', 'codex', 'cursor'];

const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes('backlens') && /\bhook stop\b/.test(h.command);

function readJson(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new Error(`${file} is not valid JSON; fix it (or move it away) and run this again. Nothing was changed.`);
  }
}

function writeJson(file, data) {
  // Nothing left (after an uninstall): remove the file, and its folder if that is now empty.
  const empty = !Object.keys(data).length || (Object.keys(data).length === 1 && data.version === 1 && !data.hooks) || (data.version === 1 && data.hooks && !Object.keys(data.hooks).length && Object.keys(data).length === 2);
  if (empty) {
    rmSync(file, { force: true });
    try {
      if (!readdirSync(dirname(file)).length) rmdirSync(dirname(file));
    } catch {}
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Claude Code and Codex: hooks.Stop = [{ hooks: [{ type, command, timeout }] }]. Adds (or with
 * uninstall removes) ours; other hooks stay. Pure.
 */
export function withStopHook(settings, command, uninstall = false) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  const groups = Array.isArray(next.hooks.Stop) ? next.hooks.Stop : [];
  const cleaned = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
  if (!uninstall) cleaned.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] });
  if (cleaned.length) next.hooks.Stop = cleaned;
  else delete next.hooks.Stop;
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

/** Cursor: { version: 1, hooks: { stop: [{ command, timeout, loop_limit }] } }. One retry per turn, like the others. Pure. */
export function withCursorStopHook(config, command, uninstall = false) {
  const next = { version: 1, ...config, hooks: { ...(config.hooks || {}) } };
  const list = (Array.isArray(next.hooks.stop) ? next.hooks.stop : []).filter((h) => !isOurs(h));
  if (!uninstall) list.push({ command, timeout: HOOK_TIMEOUT_S, loop_limit: 1 });
  if (list.length) next.hooks.stop = list;
  else delete next.hooks.stop;
  return next;
}

/** .mcp.json / .cursor/mcp.json: adds (or removes) the backlens server. Leaves a user's own entry alone. Pure. */
export function withMcp(config, uninstall = false) {
  const servers = { ...(config.mcpServers || {}) };
  if (uninstall) {
    if (servers.backlens && JSON.stringify(servers.backlens) === JSON.stringify(MCP_ENTRY)) delete servers.backlens;
  } else if (!servers.backlens) servers.backlens = MCP_ENTRY;
  const next = { ...config, mcpServers: servers };
  if (!Object.keys(servers).length) delete next.mcpServers;
  return next;
}

/** The files each harness uses, and how to change them. */
function plan(harness, root) {
  if (harness === 'claude') return { hookFile: join(root, '.claude', 'settings.json'), hook: withStopHook, mcpFile: join(root, '.mcp.json'), reload: 'Restart Claude Code (or open /hooks) so it loads the hook.' };
  if (harness === 'codex')
    return {
      hookFile: join(root, '.codex', 'hooks.json'),
      hook: withStopHook,
      mcpFile: null,
      mcpNote: 'MCP for Codex: codex mcp add backlens -- npx -y backlens@latest mcp',
      reload: 'Codex runs repo hooks only once trusted: open /hooks in Codex and review the backlens hook.',
    };
  return { hookFile: join(root, '.cursor', 'hooks.json'), hook: withCursorStopHook, mcpFile: join(root, '.cursor', 'mcp.json'), reload: 'Restart Cursor so it loads the hook.' };
}

export async function runInit({ args, root }) {
  const harness = args.own[1];
  if (!HARNESSES.includes(harness)) {
    process.stderr.write(`usage: backlens init <${HARNESSES.join('|')}> [--uninstall] [--no-mcp] [--local]\n`);
    process.exit(1);
  }
  const uninstall = args.has('--uninstall');
  const flag = harness === 'claude' ? '' : ` --harness ${harness}`;
  const command = args.has('--local') ? `"${process.execPath}" "${BIN}" hook stop${flag}` : `npx -y backlens@latest hook stop${flag}`;
  const p = plan(harness, root);
  const out = [];
  try {
    writeJson(p.hookFile, p.hook(readJson(p.hookFile), command, uninstall));
    out.push(`${uninstall ? 'removed the' : 'added a'} stop hook in ${relative(root, p.hookFile)}${uninstall ? '' : `: ${command}`}`);
    if (!args.has('--no-mcp')) {
      if (p.mcpFile) {
        const mcp = readJson(p.mcpFile);
        const had = Boolean(mcp.mcpServers && mcp.mcpServers.backlens);
        if (uninstall || !had) writeJson(p.mcpFile, withMcp(mcp, uninstall));
        out.push(uninstall ? `removed backlens from ${relative(root, p.mcpFile)} (if this command added it)` : had ? `${relative(root, p.mcpFile)} already has a backlens server: left as it is` : `added the backlens MCP server to ${relative(root, p.mcpFile)}`);
      } else if (!uninstall) out.push(p.mcpNote);
    }
  } catch (err) {
    process.stderr.write(`backlens: ${err.message}\n`);
    process.exit(1);
  }
  if (!uninstall) {
    out.push(
      '',
      'How it works: keep `npx backlens` running for the app. When the agent finishes a turn that changed files,',
      'the hook replays one read per route: a break (500, lost field, changed type) sends the agent back to fix it',
      'once; other changes are accepted (and, in Claude Code and Codex, shown to you in a line). With backlens not',
      'running, the hook does nothing.',
    );
    // Take the baseline now, before any agent change, when backlens is already running.
    const session = findSessions(root)[0];
    if (session) {
      try {
        const list = await api(session, 'GET', '/api/behavior');
        if (!list.entries || !list.entries.length) {
          const b = await api(session, 'POST', '/api/behavior/diff', {});
          out.push('', b.created && b.captured && b.captured.length ? `Baseline taken now: ${b.captured.length} routes.` : "No baseline yet: use the app's pages once; the first finished turn takes it.");
        } else out.push('', `Baseline already there: ${list.entries.length} routes.`);
      } catch {}
    } else out.push('', 'Start `npx backlens` and use the app once; the first finished turn takes the baseline.');
    out.push('', p.reload, `Undo with: backlens init ${harness} --uninstall`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}
