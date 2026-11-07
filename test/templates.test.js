import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promiseAll } from '../ai/templates.js';

function project(code) {
  const root = mkdtempSync(join(tmpdir(), 'bl-t-'));
  writeFileSync(join(root, 'svc.ts'), code);
  return root;
}
const issue = (lines) => ({ sites: lines.map((l) => `svc.ts:${l}`) });

test('independent awaited reads become one Promise.all', () => {
  const root = project(['class S {', '  async page(id: string) {', '    const user = await this.db.users.find(id);', '    const [plan] = await this.db', '      .select()', '      .from(plans);', '    return { user, plan };', '  }', '}'].join('\n'));
  const r = promiseAll(root, issue([3, 4]));
  assert.ok(r.edits, r.reason);
  assert.deepEqual([r.edits[0].from, r.edits[0].to], [3, 6]);
  assert.equal(r.edits[0].replace, ['    const [user, [plan]] = await Promise.all([', '      this.db.users.find(id),', '      this.db', '        .select()', '        .from(plans),', '    ]);'].join('\n'));
});

test('a call that uses an earlier result is left alone', () => {
  const root = project(['async function f(id) {', '  const course = await getCourse(id);', '  const modules = await getModules(course.id);', '}'].join('\n'));
  assert.match(promiseAll(root, issue([2, 3])).reason, /uses course/);
});

test('code between the calls, type annotations and comments make it bail', () => {
  assert.match(promiseAll(project(['async function f() {', '  const a = await x();', '  log();', '  const b = await y();', '}'].join('\n')), issue([2, 4])).reason, /other code runs between/);
  assert.match(promiseAll(project(['async function f() {', '  const a: A = await x();', '  const b = await y();', '}'].join('\n')), issue([2, 3])).reason, /type annotation/);
  assert.match(promiseAll(project(['async function f() {', '  const a = await x();', '  // keep b after a', '  const b = await y();', '}'].join('\n')), issue([2, 4])).reason, /comments/);
});

test('bare awaits keep their places with holes', () => {
  const root = project(['async function f() {', '  await warm();', '  const b = await y();', '}'].join('\n'));
  assert.equal(promiseAll(root, issue([2, 3])).edits[0].replace, ['  const [, b] = await Promise.all([', '    warm(),', '    y(),', '  ]);'].join('\n'));
});
