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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { call } from './handlers.js';
import { TOOLS } from './tools.js';
import { VERSION } from './version.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

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
