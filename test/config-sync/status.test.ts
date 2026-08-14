// ── Config Sync status 读取器单测（i4-2 §三.3）──
// applied/fleetHead/pending/dims/warnings 磁盘真源组装；git 失败降级 null；
// pending = fleet 工作树 bundle 与 applied 版本差（同步未达呈现代理）。

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfigSyncStatus, resetAppliedCacheForTest } from '../../src/config-sync/status.js';
import type { SyncBundle } from '../../src/config-sync/types.js';

let tmpRoot: string;
let fleetRoot: string;
let configDir: string;

async function writeFleetBundle(bundle: unknown): Promise<void> {
  const p = path.join(fleetRoot, 'TriMetaverse', 'docs', 'registry', 'init-sync', 'sync-config.json');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(bundle, null, 2), 'utf-8');
}

async function writeAppliedManifest(manifest: unknown): Promise<void> {
  const dir = path.join(configDir, 'init-sync');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'applied.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

function bundleFixture(overrides?: Partial<SyncBundle>): SyncBundle {
  return {
    schemaVersion: 1,
    bundleId: 'bundle-0001',
    generatedAt: '2026-08-14T10:00:00.000Z',
    generatedBy: 'trilc-init-0.9.0@a1b2c3d4',
    company: { state: 'initialized', ceoName: 'MoRen', onboardedAt: '2026-08-14T09:00:00.000Z' },
    model: { defaultModel: 'tmv-deepseek-v4-pro', catalog: [], providers: [] },
    keys: { providers: [], refreshIntervalS: 900, fetchedAt: '2026-08-14T09:59:00.000Z' },
    employees: { roster: [], sourceCommit: '1111111111111111111111111111111111111111' },
    project: {
      projectKey: 'trimetaverse',
      repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
      defaultBranch: 'dev',
      worktrees: [],
      devHead: '2222222222222222222222222222222222222222',
    },
    ...overrides,
  };
}

const scriptedGit = (...responses: Array<{ code: number; stdout: string; stderr: string }>) => {
  const queue = [...responses];
  return async () => queue.shift() ?? { code: 0, stdout: '', stderr: '' };
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-sync-status-'));
  fleetRoot = path.join(tmpRoot, 'fleet');
  configDir = path.join(tmpRoot, 'config');
  await fs.mkdir(path.join(fleetRoot, 'TriMetaverse'), { recursive: true });
  resetAppliedCacheForTest();
});

describe('readConfigSyncStatus', () => {
  it('空态：applied/fleetHead/pending/dims 全 null，warnings 空', async () => {
    const git = scriptedGit(
      { code: 1, stdout: '', stderr: 'not a git repo' },
      { code: 1, stdout: '', stderr: 'not a git repo' },
    );
    const status = await readConfigSyncStatus({ fleetRoot, configDir, git });
    assert.deepEqual(status, {
      ok: true,
      applied: null,
      fleetHead: null,
      dims: null,
      pending: null,
      project: null,
      warnings: [],
    });
  });

  it('applied 后：applied 摘要 + fleetHead + dims + pending 呈现代理', async () => {
    await writeAppliedManifest({
      schemaVersion: 1,
      bundleId: 'bundle-0001',
      generatedAt: '2026-08-14T10:00:00.000Z',
      contentHash: 'hash-abc',
      sourceInstanceId: 'trilc-init-0.9.0@a1b2c3d4',
      lastAppliedAt: '2026-08-14T10:05:00.000Z',
      dims: { company: 'applied', model: 'applied', keys: 'applied', employees: 'warning', project: 'applied' },
      warnings: ['employees: fleet lag'],
    });
    // fleet 工作树 bundle 与 applied 同 bundleId → pending null（版本无差）
    await writeFleetBundle(bundleFixture({ bundleId: 'bundle-0001' }));
    const git = scriptedGit(
      { code: 0, stdout: 'abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' },
      { code: 0, stdout: 'dev\n', stderr: '' },
    );
    const status = await readConfigSyncStatus({ fleetRoot, configDir, git });
    assert.equal(status.applied?.bundleId, 'bundle-0001');
    assert.equal(status.applied?.sourceInstanceId, 'trilc-init-0.9.0@a1b2c3d4');
    assert.deepEqual(status.fleetHead, { branch: 'dev', commit: 'abcdef1234567890abcdef1234567890abcdef12' });
    assert.equal(status.dims?.employees, 'warning');
    assert.deepEqual(status.warnings, ['employees: fleet lag']);
    // 同 bundleId → pending null（版本无差）
    assert.equal(status.pending, null);
    // project 维未落地（测试仅写 applied.json）→ null
    assert.equal(status.project, null);
  });

  it('project 维文件落地 → status.project 呈现（L1 三面比对事实源）', async () => {
    const dir = path.join(configDir, 'init-sync');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'project.json'),
      JSON.stringify({
        projectKey: 'trimetaverse',
        repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
        defaultBranch: 'dev',
        worktrees: [{ path: 'D:/Code/ai/TriMetaverse', branch: 'dev' }],
        devHead: '2222222222222222222222222222222222222222',
      }),
      'utf-8',
    );
    const status = await readConfigSyncStatus({ fleetRoot, configDir, git: scriptedGit() });
    assert.equal(status.project?.projectKey, 'trimetaverse');
    assert.equal(status.project?.repoUrl, 'https://github.com/MoRen9527/TriMetaverse.git');
    assert.equal(status.project?.worktrees[0].branch, 'dev');
    assert.equal(status.project?.devHead, '2222222222222222222222222222222222222222');
  });

  it('fleet bundle 与 applied 版本差 → pending 非 null', async () => {
    await writeAppliedManifest({
      schemaVersion: 1,
      bundleId: 'bundle-old',
      generatedAt: '2026-08-13T10:00:00.000Z',
      contentHash: 'hash-old',
      sourceInstanceId: 'trilc-init-0.9.0@a1b2c3d4',
      lastAppliedAt: '2026-08-13T10:05:00.000Z',
      dims: { company: 'applied', model: 'applied', keys: 'applied', employees: 'applied', project: 'applied' },
    });
    await writeFleetBundle(bundleFixture());
    const git = scriptedGit(
      { code: 1, stdout: '', stderr: 'no git' },
      { code: 1, stdout: '', stderr: 'no git' },
    );
    const status = await readConfigSyncStatus({ fleetRoot, configDir, git });
    assert.deepEqual(status.pending, { bundleId: 'bundle-0001', generatedAt: '2026-08-14T10:00:00.000Z' });
    assert.equal(status.fleetHead, null);
  });

  it('applied.json 坏形状 → applied null 不抛错', async () => {
    await writeAppliedManifest({ not: 'a manifest' });
    const git = scriptedGit(
      { code: 1, stdout: '', stderr: 'no git' },
      { code: 1, stdout: '', stderr: 'no git' },
    );
    const status = await readConfigSyncStatus({ fleetRoot, configDir, git });
    assert.equal(status.applied, null);
  });
});
