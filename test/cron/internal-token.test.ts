import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * LG-022 修复逻辑单测：cwd 探测链（src 面 tsx 直跑时模块相对阶=仓根 docker/.env。
 * 本仓 docker/.env 为模板值、无 TRIMC_INTERNAL_TOKEN 键，故模块相对阶不命中、
 * 测试观测的是 cwd 链行为；受控 cwd 均以注入参数提供临时目录，不读取仓根
 * docker/.env 内容、不依赖其存在。已知限制：若未来仓根 docker/.env 加入同名键，
 * 模块相对阶将先命中并导致本组测试暴露失败（可见而非误通过）。
 */

/** 建受控临时目录树：每个条目建 <root>/<dir>/docker/（token 给定则写 .env）。返回根路径。 */
function makeTempEnvTree(entries: Array<{ dir: string; token?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'trimc-internal-token-'));
  for (const { dir, token } of entries) {
    const d = join(root, dir);
    mkdirSync(join(d, 'docker'), { recursive: true });
    if (token !== undefined) {
      writeFileSync(join(d, 'docker', '.env'), `TRIMC_INTERNAL_TOKEN=${token}\n`, 'utf-8');
    }
  }
  return root;
}

test('resolveInternalToken: cwd 链命中（无 env；注入受控 cwd）', () => {
  const root = makeTempEnvTree([{ dir: 'proj', token: 'cwd-token' }]);
  try {
    assert.equal(resolveInternalToken({}, join(root, 'proj')), 'cwd-token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInternalToken: cwd 链上溯命中（自身档无 .env，祖先档有）', () => {
  const root = makeTempEnvTree([
    { dir: 'outer', token: 'ancestor-token' },
    { dir: 'outer/inner/deep' }, // 无 docker/.env
  ]);
  try {
    assert.equal(resolveInternalToken({}, join(root, 'outer', 'inner', 'deep')), 'ancestor-token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInternalToken: cwd 链自身档优先于祖先档（首个命中即停）', () => {
  const root = makeTempEnvTree([
    { dir: 'outer', token: 'ancestor-token' },
    { dir: 'outer/inner', token: 'inner-token' },
  ]);
  try {
    assert.equal(resolveInternalToken({}, join(root, 'outer', 'inner')), 'inner-token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInternalToken: env 注入优先于 cwd 链命中', () => {
  const root = makeTempEnvTree([{ dir: 'proj', token: 'cwd-token' }]);
  try {
    assert.equal(resolveInternalToken({ TRIMC_INTERNAL_TOKEN: 'env-token' }, join(root, 'proj')), 'env-token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInternalToken: 上溯超 3 层不命中（上限生效）→ undefined', () => {
  const root = makeTempEnvTree([
    { dir: 'top', token: 'too-far-token' },
    { dir: 'top/a/b/c/d' }, // 无 docker/.env
  ]);
  try {
    // cwd 档 d + 上溯 c/b/a 共 4 档；top 是第 4 个祖先（超出）→ 不探测
    assert.equal(resolveInternalToken({}, join(root, 'top', 'a', 'b', 'c', 'd')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInternalToken: 三链皆无 → undefined（行为同旧）', () => {
  const root = makeTempEnvTree([{ dir: 'empty' }]); // 有目录无 docker/.env
  try {
    assert.equal(resolveInternalToken({}, join(root, 'empty')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
