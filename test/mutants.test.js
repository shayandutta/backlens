import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { apply, mutantsOf } from '../src/mutate/mutants.js';

const ts = createRequire(import.meta.url)('typescript');

test('guards, access decorators and boundaries become mutants', () => {
  const text = `@Controller('admin')
export class Admin {
  @Get('users') @UseGuards(AdminGuard)
  list(user: User, n: number) {
    if (user.role !== 'admin') throw new ForbiddenException();
    if (n >= 100) { return res.status(400).send('too many'); }
    if (n > 3) console.log('big');
    return [];
  }
}`;
  const ms = mutantsOf('admin.ts', text, ts);
  const ops = ms.map((m) => `${m.operator}@${m.line}`);
  assert.deepEqual(ops.sort(), ['boundary@6', 'remove-decorator@3', 'remove-guard@5', 'remove-guard@6'].sort(), 'only guards that stop the request, not plain ifs');
  const guard = ms.find((m) => m.operator === 'remove-guard' && m.line === 5);
  assert.ok(!apply(text, guard).includes("user.role !== 'admin'"));
  assert.match(guard.describe, /removed the check `if \(user\.role !== 'admin'\)`/);
  const b = ms.find((m) => m.operator === 'boundary');
  assert.match(apply(text, b), /if \(n > 100\)/);
  assert.equal(mutantsOf('x.ts', text, null).length, 0, 'no TypeScript, no mutants');
});
