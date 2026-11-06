import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildContext, enclosing, insideProject, scrub } from '../ai/context.js';
import { costUsd, route } from '../ai/router.js';

const issue = (over = {}) => ({ type: 'repeat', title: 'The same call is made twice in one request', route: 'GET /a', sites: ['src/a.ts:10', 'src/a.ts:20'], sql: 'select 1', fix: 'reuse', frames: [], ...over });
const ctx = { tokens: 4000, files: [] };
const claude = { provider: 'anthropic' };

test('the router never spends money unless Claude is picked', () => {
  assert.equal(route({ task: 'fix', issue: issue(), ctx, settings: { provider: 'mock' } }).kind, 'mock');
  const local = route({ task: 'fix', issue: issue(), ctx, settings: { provider: 'ollama', ollamaModel: 'qwen2.5-coder:3b' } });
  assert.equal(local.kind, 'ollama');
  assert.equal(local.estimateUsd, 0);
});

test('index advice is a template, never a model call', () => {
  assert.equal(route({ task: 'fix', issue: issue({ type: 'index' }), ctx, settings: claude }).kind, 'template');
});

test('explaining goes to the cheapest model', () => {
  assert.equal(route({ task: 'explain', issue: issue(), ctx, settings: claude }).tier, 'haiku');
});

test('one-file fixes with tests go to Sonnet; cross-file without tests go to Opus', () => {
  assert.equal(route({ task: 'fix', issue: issue(), ctx, settings: claude, hasTests: true }).tier, 'sonnet');
  const hard = route({ task: 'fix', issue: issue({ sites: ['src/a.ts:10', 'src/b.ts:5'] }), ctx, settings: claude, hasTests: false });
  assert.equal(hard.tier, 'opus');
  assert.ok(hard.reasons.some((r) => /different files/.test(r)));
});

test('a failed check steps up exactly one tier', () => {
  const again = route({ task: 'fix', issue: issue(), ctx, settings: claude, hasTests: true, attempt: 1 });
  assert.equal(again.tier, 'opus');
  assert.equal(again.effort, 'high');
});

test('history moves a kind of issue up when the smaller model keeps failing', () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ type: 'repeat', tier: 'sonnet', verified: i === 0 }));
  assert.equal(route({ task: 'fix', issue: issue(), ctx, settings: claude, history, hasTests: true }).tier, 'opus');
});

test('cost counts cache reads at the cache price', () => {
  assert.equal(costUsd('opus', { input_tokens: 1_000_000, output_tokens: 0 }), 4);
  assert.equal(costUsd('opus', { cache_read_input_tokens: 1_000_000, output_tokens: 0 }), 0.2);
});

test('secrets never reach the model', () => {
  const text = `const apiKey = "abcdef123456";\nconst url = "postgres://kosmo:hunter22@db/kosmo";\nconst k = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA';\nconst ok = "hello";`;
  const out = scrub(text);
  assert.ok(!out.includes('abcdef123456') && !out.includes('hunter22') && !out.includes('AAAAAAAAAAAAAAAA'));
  assert.ok(out.includes('"hello"'));
});

test('context stays inside the project and away from .env and node_modules', () => {
  const root = '/proj';
  assert.equal(insideProject(root, '../etc/passwd'), null);
  assert.equal(insideProject(root, '.env'), null);
  assert.equal(insideProject(root, 'node_modules/x/index.js'), null);
  assert.equal(insideProject(root, 'src/a.ts'), '/proj/src/a.ts');
});

test('the enclosing function is found from a line inside it', () => {
  const lines = ['import x from "y";', '', 'export class S {', '  async lesson(id: string) {', '    const a = await one();', '    if (a) {', '      return two(a);', '    }', '    return null;', '  }', '', '  other() {}', '}'];
  assert.deepEqual(enclosing(lines, 7), { from: 4, to: 10 });
});

test('context reads the function around each recorded site, with line numbers', () => {
  const root = mkdtempSync(join(tmpdir(), 'bl-'));
  writeFileSync(join(root, 'a.ts'), ['function load(id) {', '  const x = db.q(id);', '  const y = db.q(id);', '  return [x, y];', '}', 'const secret = "password=supersecretvalue";'].join('\n'));
  const c = buildContext(root, issue({ sites: ['a.ts:2', 'a.ts:3'] }));
  assert.equal(c.files.length, 1);
  assert.deepEqual(c.preview, [{ path: 'a.ts', from: 1, to: 5 }]);
  assert.match(c.files[0].text, /^ {4}1 {2}function load/);
  assert.ok(!c.files[0].text.includes('secret'));
});

test('model code is cleaned of fences and copied line numbers', async () => {
  const { cleanCode } = await import('../ai/fixes.js');
  assert.equal(cleanCode('```ts\n   74  const a = 1;\n   75  return a;   \n```'), 'const a = 1;\nreturn a;');
  assert.equal(cleanCode('  if (x) {\n    y();\n  }'), '  if (x) {\n    y();\n  }');
});

test('a find that ends mid-line keeps the rest of the line', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createAI } = await import('../ai/fixes.js');
  const root = mkdtempSync(join(tmpdir(), 'bl-'));
  writeFileSync(join(root, 'a.ts'), ['class S {', '  send() {', '    return this.mine(id);', '  }', '', '  async remove(id: string) {', '  }', '}'].join('\n'));
  const issue = { key: 'k', type: 'repeat', title: 't', route: 'GET /', sites: ['a.ts:3'], sql: '', fix: '', frames: [], example: 'x', seen: 1, of: 1, cost: 1 };
  const ai = createAI({ root, pm: 'npm', config: () => null, readProject: () => ({ scripts: {} }), getIssue: () => issue, pauseWatch: () => {} });
  writeFileSync(join(root, '.fixture'), '');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, '.backlens'), { recursive: true });
  writeFileSync(join(root, '.backlens', 'ai-fixtures.json'), JSON.stringify([{ match: 'a.ts', response: { explanation: 'x', confidence: 'high', notes: '', edits: [{ file: 'a.ts', find: '    return this.mine(id);\n  }\n\n  async remove', replace: '    return this.mine(id, true);\n  }\n\n  async remove' }] } }]));
  ai.saveSettings({ provider: 'mock' });
  const job = await ai.startFix('k');
  await ai.send(job.id);
  await new Promise((r) => setTimeout(r, 50));
  const done = ai.getFix(job.id);
  assert.equal(done.stage, 'proposed');
  assert.equal(done.edits[0].replace.split('\n').at(-1), '  async remove(id: string) {');
  assert.deepEqual(done.diff[0].removed.map((l) => l.text), ['    return this.mine(id);']);
  assert.ok(readFileSync(join(root, 'a.ts'), 'utf8').includes('async remove(id: string)'));
});
