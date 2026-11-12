import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildContext, enclosing, insideProject, scrub } from '../src/ai/context.js';
import { costUsd, route } from '../src/ai/router.js';

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
  const { cleanCode } = await import('../src/ai/index.js');
  assert.equal(cleanCode('```ts\n   74  const a = 1;\n   75  return a;   \n```'), 'const a = 1;\nreturn a;');
  assert.equal(cleanCode('  if (x) {\n    y();\n  }'), '  if (x) {\n    y();\n  }');
});

test('a find that ends mid-line keeps the rest of the line', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createAI } = await import('../src/ai/index.js');
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

test('an edit numbered after an earlier edit is caught and the original lines are named', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createAI } = await import('../src/ai/index.js');
  const root = mkdtempSync(join(tmpdir(), 'bl-'));
  const body = ['async function wall() {', '  const a = await one();', '  for (const x of a) {', '    await two(x);', '  }', '  return {', '    total: a.length,', '    items: a,', '  };', '}', ''];
  writeFileSync(join(root, 'a.ts'), body.join('\n'));
  const issue = { key: 'k', type: 'n-plus-one', title: 't', route: 'GET /', sites: ['a.ts:4'], sql: '', fix: '', frames: [], example: 'x', seen: 1, of: 1, cost: 1 };
  const ai = createAI({ root, pm: 'npm', config: () => null, readProject: () => ({ scripts: {} }), getIssue: () => issue, pauseWatch: () => {} });
  mkdirSync(join(root, '.backlens'), { recursive: true });
  // Lines 3-5 become 6 lines (+3), then line 8 of the original is called line 11.
  const edits = [
    { file: 'a.ts', from_line: 3, to_line: 5, new_code: '  const b = await all(a);\n  void b;\n  void b;\n  void b;\n  void b;\n  void b;' },
    { file: 'a.ts', from_line: 11, to_line: 11, new_code: '    items: b,' },
  ];
  writeFileSync(join(root, '.backlens', 'ai-fixtures.json'), JSON.stringify([{ match: 'a.ts', response: { explanation: 'x', confidence: 'high', notes: '', edits } }]));
  ai.saveSettings({ provider: 'mock' });
  const job = await ai.startFix('k');
  await ai.send(job.id);
  await new Promise((r) => setTimeout(r, 50));
  const done = ai.getFix(job.id);
  assert.equal(done.rejected.length, 1);
  assert.match(done.rejected[0].reason, /as if your earlier edit were already applied.*lines 8-8/);
});

test('a fix applies to a file with uncommitted changes, and revert never overwrites later edits', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createAI } = await import('../src/ai/index.js');
  const root = mkdtempSync(join(tmpdir(), 'bl-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const file = join(root, 'a.ts');
  writeFileSync(file, ['async function f() {', '  const a = await one();', '  const b = await two();', '  return [a, b];', '}', ''].join('\n'));
  git('add', '.');
  git('commit', '-qm', 'x');
  // Uncommitted work: a comment at the end.
  const dirty = readFileSync(file, 'utf8') + '// work in progress\n';
  writeFileSync(file, dirty);

  const issue = { key: 'k', type: 'repeat', title: 't', route: 'GET /', sites: ['a.ts:2'], sql: '', fix: '', frames: [], example: 'x', seen: 1, of: 1, cost: 1 };
  const deps = { root, pm: 'npm', config: () => null, readProject: () => ({ scripts: {} }), getIssue: () => issue, pauseWatch: () => {}, restartApp: async () => null, appPort: () => null, getReplay: () => null, getTrace: () => null };
  mkdirSync(join(root, '.backlens'), { recursive: true });
  writeFileSync(join(root, '.backlens', 'ai-fixtures.json'), JSON.stringify([{ match: 'a.ts', response: { explanation: 'x', confidence: 'high', notes: '', edits: [{ file: 'a.ts', from_line: 2, to_line: 2, new_code: '  const a = await one(true);' }] } }]));
  const settle = () => new Promise((r) => setTimeout(r, 100));

  const run = async () => {
    const ai = createAI(deps);
    ai.saveSettings({ provider: 'mock', replay: false });
    const job = await ai.startFix('k');
    await ai.send(job.id);
    await settle();
    ai.apply(job.id);
    await settle();
    return { ai, id: job.id };
  };

  let { ai, id } = await run();
  assert.ok(readFileSync(file, 'utf8').includes('one(true)'));
  await ai.revert(id);
  await settle();
  assert.equal(readFileSync(file, 'utf8'), dirty, 'revert brings back the uncommitted version exactly');

  ({ ai, id } = await run());
  const edited = readFileSync(file, 'utf8') + '// edited by hand after the fix\n';
  writeFileSync(file, edited);
  await assert.rejects(ai.revert(id), /changed after the fix was applied/);
  assert.equal(readFileSync(file, 'utf8'), edited, 'the later edit is left alone');
});
