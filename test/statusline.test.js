import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'statusline.js');
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'backlens.js');

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'backlens-statusline-'));
  const env = { ...process.env, BACKLENS_HOME: join(base, 'backlens'), CLAUDE_CONFIG_DIR: join(base, 'claude') };
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  return { base, env, done: () => rmSync(base, { recursive: true, force: true }) };
}

const update = (five, seven) => JSON.stringify({ session_id: 's', model: { id: 'claude-opus-5-5' }, rate_limits: { five_hour: { used_percentage: five, resets_at: 1000 }, seven_day: { used_percentage: seven, resets_at: 2000 } } });

test('install wraps the status line the user had, records only plan limits, and uninstall puts it back', () => {
  const s = sandbox();
  try {
    const settings = join(s.env.CLAUDE_CONFIG_DIR, 'settings.json');
    const mine = { type: 'command', command: 'cat >/dev/null; echo my-status-line', padding: 1 };
    writeFileSync(settings, JSON.stringify({ model: 'opus', statusLine: mine }));

    const out = spawnSync(process.execPath, [BIN, 'statusline', '--install'], { env: s.env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(after.model, 'opus', 'other settings stay');
    assert.equal(after.statusLine.padding, 1);
    assert.match(after.statusLine.command, /statusline\.js"$/);
    assert.match(spawnSync(process.execPath, [BIN, 'statusline', '--install'], { env: s.env, encoding: 'utf8' }).stdout, /already/);

    // Claude Code runs the command through a shell with the update on stdin.
    const run = (input) => spawnSync(after.statusLine.command, { shell: true, input, env: s.env, encoding: 'utf8' });
    const first = run(update(12, 30));
    assert.equal(first.stdout.trim(), 'my-status-line', 'the old status line still prints');
    run(update(12, 30));
    run(update(15, 31));
    run(update(13, 30)); // an idle session's older numbers
    const lines = readFileSync(join(s.env.BACKLENS_HOME, 'limits.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2, 'unchanged and stale updates are not written');
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'five', 'fiveResets', 'seven', 'sevenResets']);
    assert.equal(lines[1].five, 15);
    assert.equal(run('not json').stdout.trim(), 'my-status-line', 'bad input never breaks the status line');

    const undo = spawnSync(process.execPath, [BIN, 'statusline', '--uninstall'], { env: s.env, encoding: 'utf8' });
    assert.match(undo.stdout, /restored/);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).statusLine, mine);
  } finally {
    s.done();
  }
});

test('a prompt\'s share of the limit spans a window reset and needs samples at both ends', async () => {
  const { limitUsed } = await import(SCRIPT);
  const m = 60e3;
  const samples = [
    { at: 0, five: 90, fiveResets: 1 },
    { at: 2 * m, five: 96, fiveResets: 1 },
    { at: 3 * m, five: 2, fiveResets: 2 },
  ];
  assert.equal(limitUsed(samples, m, 2 * m, 'five'), 6);
  assert.equal(limitUsed(samples, m, 3 * m, 'five'), 8, '6 before the reset, 2 after');
  assert.equal(limitUsed(samples, 60 * m, 61 * m, 'five'), null, 'no recent sample: unknown, not zero');
  assert.equal(limitUsed([], 0, m, 'five'), null);
});
