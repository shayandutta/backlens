import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentKey, looksLikeKey, removeKey, saveKey, savedKey } from '../src/ai/credentials.js';
import { anthropicStatus, recommendedModel } from '../src/ai/providers/index.js';

const KEY = `sk-ant-api03-${'a'.repeat(40)}wxyz`;

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'backlens-home-'));
  const before = { home: process.env.BACKLENS_HOME, key: process.env.ANTHROPIC_API_KEY };
  process.env.BACKLENS_HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return fn(home);
  } finally {
    if (before.home === undefined) delete process.env.BACKLENS_HOME;
    else process.env.BACKLENS_HOME = before.home;
    if (before.key !== undefined) process.env.ANTHROPIC_API_KEY = before.key;
    rmSync(home, { recursive: true, force: true });
  }
}

test('only Claude-shaped keys are accepted', () => {
  assert.ok(looksLikeKey(KEY));
  assert.ok(!looksLikeKey('sk-proj-abc'));
  assert.ok(!looksLikeKey(`${KEY} and more`));
  assert.ok(!looksLikeKey(''));
  assert.throws(() => saveKey('hello'), /does not look like/);
});

test('a saved key lives outside the project, readable by the user only', () => {
  withHome((home) => {
    saveKey(KEY);
    assert.equal(savedKey(), KEY);
    if (process.platform !== 'win32') assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
    assert.deepEqual(currentKey(), { key: KEY, source: 'saved' });
    removeKey();
    assert.equal(savedKey(), null);
  });
});

test('ANTHROPIC_API_KEY wins over the saved key, and status never carries the key', () => {
  withHome(() => {
    saveKey(KEY);
    process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${'b'.repeat(40)}1234`;
    try {
      assert.equal(currentKey().source, 'env');
      const status = anthropicStatus();
      assert.deepEqual(status, { configured: true, source: 'env', last4: '1234' });
      assert.ok(!JSON.stringify(status).includes('bbbb'));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

test('the local model suggested fits the memory', () => {
  assert.equal(recommendedModel(8).name, 'qwen2.5-coder:3b');
  assert.equal(recommendedModel(16).name, 'qwen2.5-coder:7b');
  assert.equal(recommendedModel(64).name, 'qwen2.5-coder:14b');
});
