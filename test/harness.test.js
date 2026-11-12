import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withCursorStopHook, withMcp, withStopHook } from '../src/harness/init.js';
import { decide, normalizeInput, toHarness } from '../src/harness/stop-hook.js';

const CMD = 'npx -y backlens@latest hook stop';

test('the Stop hook merges into existing settings and uninstalls cleanly', () => {
  const mine = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
  const added = withStopHook(mine, CMD);
  assert.deepEqual(added.permissions, mine.permissions);
  assert.equal(added.hooks.Stop.length, 2);
  assert.equal(added.hooks.Stop[1].hooks[0].command, CMD);
  // Installing twice keeps one backlens hook (a changed command replaces the old one).
  assert.equal(withStopHook(added, `${CMD} --x`).hooks.Stop.filter((g) => g.hooks.some((h) => h.command.includes('backlens'))).length, 1);
  assert.deepEqual(withStopHook(added, CMD, true), mine);
  assert.deepEqual(withStopHook(withStopHook({}, CMD), CMD, true), {});
});

test('Cursor gets its own hooks.json shape with one retry', () => {
  const c = withCursorStopHook({ version: 1, hooks: { afterFileEdit: [{ command: 'fmt' }] } }, `${CMD} --harness cursor`);
  assert.deepEqual(c.hooks.stop, [{ command: `${CMD} --harness cursor`, timeout: 90, loop_limit: 1 }]);
  assert.deepEqual(c.hooks.afterFileEdit, [{ command: 'fmt' }]);
  assert.deepEqual(withCursorStopHook(c, '', true).hooks, { afterFileEdit: [{ command: 'fmt' }] });
});

test('the MCP entry is added once and a user-made one is left alone', () => {
  assert.deepEqual(withMcp({}).mcpServers.backlens, { command: 'npx', args: ['-y', 'backlens@latest', 'mcp'] });
  const own = { mcpServers: { backlens: { command: 'node', args: ['local.js'] } } };
  assert.deepEqual(withMcp(own), own);
  assert.deepEqual(withMcp(own, true), own, 'uninstall never removes an entry it did not write');
  assert.deepEqual(withMcp(withMcp({}), true), {});
});

const result = (findings) => ({ checked: 3, results: findings.length ? [{ route: 'GET /me', findings }] : [], broken: findings.filter((f) => f.kind === 'broken').length, skipped: [] });

test('a break blocks the first stop and tells the agent what broke', () => {
  const d = decide({ stop_hook_active: false }, result([{ kind: 'broken', what: 'response lost $.email' }]));
  assert.equal(d.output.decision, 'block');
  assert.match(d.output.reason, /GET \/me\n {2}✗ response lost \$\.email/);
  assert.match(d.output.reason, /npx backlens accept "GET \/me"/);
  assert.equal(d.saveTree, false);
});

test('a second stop with the break still there is let through, with a note for the user', () => {
  const d = decide({ stop_hook_active: true }, result([{ kind: 'broken', what: 'answers 500 (was 200)' }]));
  assert.equal(d.output.decision, undefined);
  assert.match(d.output.systemMessage, /still broken/);
});

test('changes are shown once and accepted; nothing changed is silent', () => {
  const d = decide({}, result([{ kind: 'changed', what: '1 more query (1 -> 2)' }]));
  assert.deepEqual(d.accept, ['GET /me']);
  assert.match(d.output.systemMessage, /1 route behave/);
  assert.deepEqual(decide({}, result([])), { output: null, accept: [], saveTree: true });
  assert.match(decide({}, { error: 'took longer than 45 s' }).output.systemMessage, /did not run/);
});

test('Cursor input and output are translated', () => {
  assert.deepEqual(normalizeInput({ workspace_roots: ['/p'], loop_count: 1, status: 'completed', conversation_id: 'c' }, 'cursor'), { cwd: '/p', retry: true, session: 'c', skip: false });
  assert.equal(normalizeInput({ status: 'aborted' }, 'cursor').skip, true);
  assert.deepEqual(normalizeInput({ cwd: '/p', stop_hook_active: true, session_id: 's' }, 'codex'), { cwd: '/p', retry: true, session: 's', skip: false });
  assert.deepEqual(toHarness({ decision: 'block', reason: 'fix it' }, 'cursor'), { followup_message: 'fix it' });
  assert.equal(toHarness({ systemMessage: 'fyi' }, 'cursor'), null);
  assert.deepEqual(toHarness({ decision: 'block', reason: 'r' }, 'codex'), { decision: 'block', reason: 'r' });
});
