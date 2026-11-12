import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedFiles, impactOf, usageOf } from '../src/diff/impact.js';

const routes = [
  { route: 'GET /orders', files: ['src/orders.ts', 'src/db.ts'], tables: ['orders'] },
  { route: 'POST /orders', files: ['src/checkout.ts', 'src/db.ts'], tables: ['orders', 'stock'] },
  { route: 'GET /users', files: ['src/users.ts'], tables: ['users'] },
];
const tablesByFile = new Map([['src/checkout.ts', new Set(['orders', 'stock'])]]);

test('a change reaches the routes that ran its file, and those sharing its tables', () => {
  const one = impactOf({ changed: ['src/users.ts'], routes, tablesByFile });
  assert.deepEqual([one.scope, one.routes], ['some', ['GET /users']]);
  const shared = impactOf({ changed: ['src/checkout.ts'], routes, tablesByFile });
  assert.deepEqual(shared.routes, ['GET /orders', 'POST /orders'], 'GET /orders reads a table the changed code writes');
  assert.match(shared.why.join('\n'), /GET \/orders: reads or writes orders/);
});

test('unknown reach widens to every route; docs and tests reach none', () => {
  assert.equal(impactOf({ changed: ['src/new-helper.ts'], routes }).scope, 'all', 'a file no request ran');
  assert.equal(impactOf({ changed: ['package.json'], routes }).scope, 'all');
  assert.equal(impactOf({ changed: ['prisma/migrations/1/migration.sql'], routes }).scope, 'all');
  assert.equal(impactOf({ changed: null, routes }).scope, 'all', 'outside git');
  const none = impactOf({ changed: ['README.md', 'test/orders.test.ts', 'src/users.spec.ts'], routes });
  assert.deepEqual([none.scope, none.routes], ['none', []]);
});

test('usage comes from the code lines on recorded calls; changed files from git', () => {
  const u = usageOf([{ spans: [{ kind: 'db', name: 'select * from "orders" join users on true', frames: [{ file: 'src/orders.ts' }, { file: 'node_modules/x.js' }] }] }]);
  assert.deepEqual([...u.files], ['src/orders.ts']);
  assert.deepEqual([...u.tables].sort(), ['orders', 'users']);
  const dir = mkdtempSync(join(tmpdir(), 'backlens-impact-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, 'a.ts'), '1');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  writeFileSync(join(dir, 'a.ts'), '2');
  writeFileSync(join(dir, 'b.ts'), 'new');
  assert.deepEqual(changedFiles(dir).sort(), ['a.ts', 'b.ts']);
  assert.equal(changedFiles(tmpdir() + '/backlens-not-a-repo-' + Date.now()), null);
});
