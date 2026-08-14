// ── 模型层 default 三级解析单测（i4-2 §四）──
// env TRIMC_DEFAULT_MODEL > applied model.defaultModel > 兜底常量；
// flash 变体 = applied catalog flash 别名 > 兜底常量；无 applied 零回归面。

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_MODEL_FALLBACK,
  FLASH_MODEL_FALLBACK,
  resetModelCacheForTest,
  resolveDefaultModel,
  resolveFlashModel,
} from '../../src/config-sync/default-model.js';

let configDir: string;

async function writeModelDim(model: unknown): Promise<void> {
  const dir = path.join(configDir, 'init-sync');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'model.json'), JSON.stringify(model, null, 2), 'utf-8');
}

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-model-resolve-'));
  delete process.env.TRIMC_DEFAULT_MODEL;
  resetModelCacheForTest();
});

describe('resolveDefaultModel 三级解析', () => {
  it('无 env 无 applied → 兜底常量（零回归面：与现状一致）', async () => {
    assert.equal(await resolveDefaultModel(configDir), DEFAULT_MODEL_FALLBACK);
    assert.equal(DEFAULT_MODEL_FALLBACK, 'deepseek-v4-pro');
  });

  it('env TRIMC_DEFAULT_MODEL 最高优先', async () => {
    process.env.TRIMC_DEFAULT_MODEL = 'tmv-deepseek-v4-pro';
    await writeModelDim({ defaultModel: 'tmv-deepseek-v4-flash', catalog: [] });
    assert.equal(await resolveDefaultModel(configDir), 'tmv-deepseek-v4-pro');
  });

  it('applied model.defaultModel 次优先', async () => {
    await writeModelDim({
      defaultModel: 'tmv-deepseek-v4-pro',
      catalog: [{ id: 'tmv-deepseek-v4-pro', provider: 'deepseek', capabilities: ['chat'] }],
      providers: [],
    });
    assert.equal(await resolveDefaultModel(configDir), 'tmv-deepseek-v4-pro');
  });

  it('applied 为 unavailable 降级段 → 落入兜底常量', async () => {
    await writeModelDim({ status: 'unavailable', reason: 'TriModel unreachable' });
    assert.equal(await resolveDefaultModel(configDir), DEFAULT_MODEL_FALLBACK);
  });

  it('model.json 缺失/坏 JSON → 兜底常量', async () => {
    assert.equal(await resolveDefaultModel(configDir), DEFAULT_MODEL_FALLBACK);
    await writeModelDim('not-json-shape');
    assert.equal(await resolveDefaultModel(configDir), DEFAULT_MODEL_FALLBACK);
  });
});

describe('resolveFlashModel flash 变体', () => {
  it('applied catalog 内 flash 别名优先', async () => {
    await writeModelDim({
      defaultModel: 'tmv-deepseek-v4-pro',
      catalog: [
        { id: 'tmv-deepseek-v4-pro', provider: 'deepseek', capabilities: ['chat'] },
        { id: 'tmv-deepseek-v4-flash', provider: 'deepseek', capabilities: ['chat'] },
      ],
      providers: [],
    });
    assert.equal(await resolveFlashModel(configDir), 'tmv-deepseek-v4-flash');
  });

  it('无 flash 别名 → 兜底常量（零回归面）', async () => {
    assert.equal(await resolveFlashModel(configDir), FLASH_MODEL_FALLBACK);
    assert.equal(FLASH_MODEL_FALLBACK, 'deepseek-v4-flash');
    await writeModelDim({
      defaultModel: 'tmv-deepseek-v4-pro',
      catalog: [{ id: 'tmv-deepseek-v4-pro', provider: 'deepseek', capabilities: ['chat'] }],
      providers: [],
    });
    assert.equal(await resolveFlashModel(configDir), FLASH_MODEL_FALLBACK);
  });
});

describe('mtime 轻缓存（D3：读取时解析）', () => {
  it('文件未变时复用缓存；文件更新后解析新鲜值', async () => {
    await writeModelDim({ defaultModel: 'model-v1', catalog: [] });
    assert.equal(await resolveDefaultModel(configDir), 'model-v1');
    // 同 mtime 内再读 → 缓存命中（值一致）
    assert.equal(await resolveDefaultModel(configDir), 'model-v1');
    // 更新文件 → mtime 变化 → 新鲜值
    await new Promise((r) => setTimeout(r, 5));
    await writeModelDim({ defaultModel: 'model-v2', catalog: [] });
    assert.equal(await resolveDefaultModel(configDir), 'model-v2');
  });
});
