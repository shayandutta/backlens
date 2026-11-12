import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentUsage, usageCost, usageText } from '../src/agent-usage/index.js';

const at = (s) => new Date(Date.now() - 3600e3 + s * 1000).toISOString();
const assistant = (id, s, content, usage) => ({ type: 'assistant', sessionId: 'S', timestamp: at(s), message: { id, model: 'claude-opus-5-5', content, usage } });
const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } };

test('reads what each prompt that used backlens cost, from Claude Code logs, without keeping any text', async () => {
  const base = mkdtempSync(join(tmpdir(), 'backlens-usage-'));
  const root = join(base, 'repo', 'apps', 'api');
  const projects = join(base, 'projects');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'x'.repeat(40000));
    writeFileSync(join(root, 'src', 'app.test.ts'), 'x'.repeat(40000));
    // A session opened at the repo root still counts for the app below it.
    const dir = join(projects, join(base, 'repo').replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'user', sessionId: 'S', timestamp: at(0), message: { role: 'user', content: 'secret prompt text: fix the slow route' } },
      // One API response is logged once per content block, with the same id and usage: counted once.
      assistant('m1', 1, [{ type: 'thinking', thinking: 'secret thoughts' }], usage),
      assistant('m1', 2, [{ type: 'tool_use', id: 't1', name: 'mcp__backlens__list_issues', input: {} }], usage),
      { type: 'user', sessionId: 'S', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'y'.repeat(4000) }] }] } },
      assistant('m2', 4, [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/app.ts' } }], usage),
      { type: 'user', sessionId: 'S', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'z'.repeat(9000) }] } },
      assistant('m3', 64, [{ type: 'text', text: 'done' }], usage),
      // A later prompt with no backlens call is not listed.
      { type: 'user', sessionId: 'S', timestamp: at(100), message: { role: 'user', content: 'thanks' } },
      assistant('m4', 101, [{ type: 'text', text: 'ok' }], usage),
    ];
    writeFileSync(join(dir, 'S.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');

    const u = await agentUsage({ root, projects, plan: { kind: 'api' }, limits: [] });
    assert.equal(u.prompts.length, 1);
    const [p] = u.prompts;
    assert.equal(p.tokens.cacheRead, 300000, 'three responses, not four log lines');
    assert.equal(p.tokens.output, 1500);
    assert.equal(p.backlensCalls, 1);
    assert.deepEqual(p.backlensTools, { list_issues: 1 });
    assert.equal(p.fileReads, 1);
    assert.equal(p.seconds, 64);
    assert.equal(p.findingsTokens, 1000, 'only backlens answers count as findings');
    assert.equal(p.usd, Math.round(3 * usageCost('claude-opus-5-5', usage) * 1e4) / 1e4);
    assert.equal(u.source.files, 1, 'tests are not source an agent searches');
    assert.ok(!JSON.stringify(u).includes('secret'), 'no prompt or reply text is returned');

    const text = usageText(u, { current: true });
    assert.match(text, /^This prompt so far: \$0\.\d+; 305k tokens/);

    // On a Claude plan the prompt costs part of its limits, read from what the status line recorded.
    const start = Date.parse(u.prompts[0].start);
    const limits = [
      { at: start - 60e3, five: 10, fiveResets: 1, seven: 3, sevenResets: 9 },
      { at: start + 30e3, five: 13, fiveResets: 1, seven: 3, sevenResets: 9 },
      { at: start + 70e3, five: 14, fiveResets: 1, seven: 4, sevenResets: 9 },
    ];
    const pro = await agentUsage({ root, projects, plan: { kind: 'plan', name: 'Pro', extraUsage: false }, limits });
    assert.deepEqual(pro.prompts[0].limits, { five: 4, seven: 1 });
    const proText = usageText(pro, { current: true });
    assert.match(proText, /^This prompt so far: 4% of your 5-hour limit, 1% of the week; 305k tokens/);
    assert.match(proText, /Billing: Claude Pro plan, a flat fee, nothing billed per prompt\. At API prices this prompt would be \$0\.\d+/);
    const unrecorded = usageText(await agentUsage({ root, projects, plan: { kind: 'plan', name: 'Pro' }, limits: [] }));
    assert.match(unrecorded, /limit use not recorded/);
    assert.match(unrecorded, /backlens statusline --install/);
    assert.match(text, /backlens handed over 1k \(90% less to read/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('prices come from the usage the API reported: 1-hour cache writes cost double input', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache reads, per million tokens.
  assert.equal(usageCost('claude-opus-5-5', { input_tokens: 1e6 }), 4);
  assert.equal(usageCost('claude-opus-5-5', { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } }), 8);
  assert.equal(usageCost('claude-opus-5-5', { cache_creation_input_tokens: 1e6 }), 5);
  assert.equal(usageCost('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40);
  assert.equal(usageCost('some-other-model', { input_tokens: 1 }), null);
});
