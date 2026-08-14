// ── Config Sync 契约类型与校验单测（i4-2 Phase B #6）──
// 覆盖：schema 校验矩阵（密钥字段递归拒绝 + keys 白名单 + 降级段）、
// contentHash 稳定键序、指纹切片。i4-3 独立复测口径①③的双保险面。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeContentHash,
  computeKeyFingerprint,
  findSecretField,
  validateSyncBundle,
  canonicalize,
  type SyncBundle,
} from '../../src/config-sync/types.js';

// ── 最小合法 bundle 工厂 ──

function validBundle(): SyncBundle {
  return {
    schemaVersion: 1,
    bundleId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    generatedAt: '2026-08-14T10:00:00.000Z',
    generatedBy: 'trilc-init-0.9.0@a1b2c3d4',
    company: { state: 'initialized', ceoName: 'MoRen', onboardedAt: '2026-08-14T09:00:00.000Z' },
    model: {
      defaultModel: 'tmv-deepseek-v4-pro',
      catalog: [
        { id: 'tmv-deepseek-v4-pro', provider: 'deepseek', capabilities: ['chat'] },
        { id: 'tmv-deepseek-v4-flash', provider: 'deepseek', capabilities: ['chat'] },
      ],
      providers: [{ provider: 'deepseek', baseUrl: 'http://127.0.0.1:3333/v1', port: 3333 }],
    },
    keys: {
      providers: [
        { provider: 'deepseek', ready: true, fingerprint: 'a1b2c3d4', baseUrl: 'http://127.0.0.1:3333/v1' },
        { provider: 'openai', ready: false },
      ],
      refreshIntervalS: 900,
      fetchedAt: '2026-08-14T09:59:00.000Z',
    },
    employees: {
      roster: [{ roleId: 'chief-technology-officer', name: '小狄' }],
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    },
    project: {
      projectKey: 'trimetaverse',
      repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
      defaultBranch: 'dev',
      worktrees: [{ path: 'D:/Code/ai/TriMetaverse', branch: 'dev' }],
      devHead: 'fedcba9876543210fedcba9876543210fedcba98',
    },
  };
}

describe('config-sync schema validation', () => {
  it('accepts a valid five-dim bundle', () => {
    const v = validateSyncBundle(validBundle());
    assert.equal(v.ok, true);
  });

  it('accepts single-dim unavailable segments (单维降级)', () => {
    const bundle = validBundle();
    bundle.model = { status: 'unavailable', reason: 'TriModel /v1/models unreachable' };
    bundle.keys = { status: 'unavailable', reason: 'key cache empty' };
    const v = validateSyncBundle(bundle);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.deepEqual(v.bundle.model, { status: 'unavailable', reason: 'TriModel /v1/models unreachable' });
    }
  });

  it('rejects api_key field at top level (snake_case)', () => {
    const v = validateSyncBundle({ ...validBundle(), api_key: 'sk-test123' });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.error, 'secret_field_rejected');
  });

  it('rejects apiKey field nested deep (camelCase)', () => {
    const bundle = validBundle();
    (bundle.model as { nested?: unknown }).nested = { deep: { apiKey: 'sk-deep123' } };
    const v = validateSyncBundle(bundle);
    assert.equal(v.ok, false);
  });

  it('rejects secret and token fields anywhere in arrays', () => {
    const bundle = validBundle();
    bundle.employees.roster.push({ roleId: 'x', name: 'y', secret: 's3cr3t' } as never);
    const v = validateSyncBundle(bundle);
    assert.equal(v.ok, false);
    const bundle2 = validBundle();
    (bundle2.project as unknown as { tags: unknown[] }).tags = [{ token: 't0ken' }];
    const v2 = validateSyncBundle(bundle2);
    assert.equal(v2.ok, false);
  });

  it('rejects non-whitelisted keys.providers[] field (防滑变)', () => {
    const bundle = validBundle();
    bundle.keys.providers[0] = { ...bundle.keys.providers[0], apiKeyMaterial: 'x' } as never;
    const v = validateSyncBundle(bundle);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.message, /not whitelisted/);
  });

  it('rejects bad schemaVersion / unparseable generatedAt / missing dim shape', () => {
    assert.equal(validateSyncBundle({ ...validBundle(), schemaVersion: 2 }).ok, false);
    assert.equal(validateSyncBundle({ ...validBundle(), generatedAt: 'not-a-date' }).ok, false);
    const noCompany = { ...validBundle() } as Partial<SyncBundle>;
    delete (noCompany as Record<string, unknown>).company;
    assert.equal(validateSyncBundle(noCompany).ok, false);
  });

  it('findSecretField skips empty-string secret values (契约口径：非空字符串才拒绝)', () => {
    assert.equal(findSecretField({ a: { api_key: '' } }, '$'), null);
    assert.equal(findSecretField({ a: { api_key: 'sk-x' } }, '$'), '$.a.api_key');
  });
});

describe('config-sync contentHash + fingerprint', () => {
  it('contentHash is stable across key-order permutations', () => {
    const a = validBundle();
    const b = validBundle();
    // 构造键序不同的同内容对象
    (b.project as unknown as Record<string, unknown>) = {
      defaultBranch: 'dev',
      devHead: 'fedcba9876543210fedcba9876543210fedcba98',
      projectKey: 'trimetaverse',
      repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
      worktrees: [{ path: 'D:/Code/ai/TriMetaverse', branch: 'dev' }],
    };
    assert.equal(computeContentHash(a), computeContentHash(b));
  });

  it('contentHash differs when content differs（devHead 除外，R1 自引用口径）', () => {
    const a = validBundle();
    const b = validBundle();
    // R1（i4-4 修正记录 ②）：project.devHead 自引用字段同口径排除——devHead 每次
    // 成功 run 必推进（bundle commit 自身 parent），纳入会使幂等重跑判定恒失效
    b.project.devHead = '0000000000000000000000000000000000000000';
    assert.equal(computeContentHash(a), computeContentHash(b)); // 仅 devHead 异 → hash 同
    b.project.repoUrl = 'https://github.com/other/repo.git';
    assert.notEqual(computeContentHash(a), computeContentHash(b)); // 其他维变化 → hash 异
  });

  it('fingerprint = sha256(material).slice(0,8) and never contains material', () => {
    const material = 'sk-very-secret-key-material-12345';
    const fp = computeKeyFingerprint(material);
    assert.match(fp, /^[0-9a-f]{8}$/);
    assert.ok(!fp.includes('sk-'));
    assert.equal(computeKeyFingerprint(material), fp); // 确定性
    assert.notEqual(computeKeyFingerprint('sk-other'), fp);
  });

  it('canonicalize is deterministic for nested structures', () => {
    assert.equal(canonicalize({ b: 1, a: [2, 3] }), canonicalize({ a: [2, 3], b: 1 }));
    assert.equal(canonicalize({ x: { y: 'z' } }), '{"x":{"y":"z"}}');
  });
});
