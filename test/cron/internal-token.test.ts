import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInternalTokenFromEnvText, resolveInternalToken } from '../../src/internal-token.js';

test('parseInternalTokenFromEnvText: 同名键解析（注释/其他键/引号/空白容错）', () => {
  const text = [
    '# trimc docker env',
    'TRIMC_URL=http://127.0.0.1:8710',
    '',
    'TRIMC_INTERNAL_TOKEN = "abc123def" ',
    'OTHER_KEY=1',
  ].join('\n');
  assert.equal(parseInternalTokenFromEnvText(text), 'abc123def');
});

test('parseInternalTokenFromEnvText: 裸值解析', () => {
  assert.equal(parseInternalTokenFromEnvText('TRIMC_INTERNAL_TOKEN=tok-value'), 'tok-value');
});

test('parseInternalTokenFromEnvText: 缺同名键 → undefined', () => {
  assert.equal(parseInternalTokenFromEnvText('A=1\nB=2'), undefined);
  assert.equal(parseInternalTokenFromEnvText(''), undefined);
});

test('resolveInternalToken: env 优先于 docker/.env', () => {
  process.env.TRIMC_INTERNAL_TOKEN = 'env-token';
  assert.equal(resolveInternalToken(), 'env-token');
  delete process.env.TRIMC_INTERNAL_TOKEN;
});

test('resolveInternalToken: env 未配置 → docker/.env 存在性决定（无文件=undefined，不抛）', () => {
  delete process.env.TRIMC_INTERNAL_TOKEN;
  const value = resolveInternalToken();
  assert.ok(value === undefined || typeof value === 'string');
});
