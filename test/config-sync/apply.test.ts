// ── Config Sync apply 执行体单测（i4-2 Phase B #6）──
// 幂等矩阵：同 bundleId no-op / 旧 generatedAt 忽略 / 旧异 hash 告警 /
// 多实例挂起告警 / 新 bundle 落地（applied.json + 各维文件原子写）/
// unavailable 维落地 / schema 拒绝 api_key / 员工维 sourceCommit 拉齐。
// 注入：临时目录 + scripted git runner（无真实 git 依赖）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runConfigSyncApply } from '../../src/config-sync/apply.js';
import { resetAppliedCacheForTest, type GitExecResult, type GitRunner } from '../../src/config-sync/status.js';
import type { SyncBundle } from '../../src/config-sync/types.js';

// ── env 面钉住（keys 维覆盖判定依赖 env；防开发机环境漂移）──

const COVERAGE_ENV_KEYS = ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TRIMODEL_TRIMETAVERSE_API_KEY'];
let prevEnv: Record<string, string | undefined> = {};

function pinEnv(coverage: Partial<Record<(typeof COVERAGE_ENV_KEYS)[number], string>>): void {
  prevEnv = {};
  for (const key of COVERAGE_ENV_KEYS) {
    prevEnv[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(coverage)) {
    if (value !== undefined) process.env[key] = value;
  }
}

// ── scripted git（按调用序出队；队空 = 成功空输出）──

interface ScriptedGit {
  git: GitRunner;
  calls: string[][];
}

function scriptedGit(...responses: GitExecResult[]): ScriptedGit {
  const queue = [...responses];
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    return queue.shift() ?? { code: 0, stdout: '', stderr: '' };
  };
  return { git, calls };
}

// ── fixture 面 ──

const DEFAULT_GENERATED_AT = '2026-08-14T10:00:00.000Z';

function bundleFixture(overrides?: Partial<SyncBundle>): SyncBundle {
  return {
    schemaVersion: 1,
    bundleId: 'bundle-0001',
    generatedAt: DEFAULT_GENERATED_AT,
    generatedBy: 'trilc-init-0.9.0@a1b2c3d4',
    company: { state: 'initialized', ceoName: 'MoRen', onboardedAt: '2026-08-14T09:00:00.000Z' },
    model: {
      defaultModel: 'tmv-deepseek-v4-pro',
      catalog: [{ id: 'tmv-deepseek-v4-pro', provider: 'deepseek', capabilities: ['chat'] }],
      providers: [{ provider: 'deepseek', baseUrl: 'http://127.0.0.1:3333/v1', port: 3333 }],
    },
    keys: {
      providers: [{ provider: 'deepseek', ready: true, fingerprint: 'a1b2c3d4' }],
      refreshIntervalS: 900,
      fetchedAt: '2026-08-14T09:59:00.000Z',
    },
    employees: {
      roster: [{ roleId: 'chief-technology-officer', name: '小狄' }],
      sourceCommit: '1111111111111111111111111111111111111111',
    },
    project: {
      projectKey: 'trimetaverse',
      repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
      defaultBranch: 'dev',
      worktrees: [{ path: 'D:/Code/ai/TriMetaverse', branch: 'dev' }],
      devHead: '2222222222222222222222222222222222222222',
    },
    ...overrides,
  };
}

let tmpRoot: string;
let fleetRoot: string;
let configDir: string;

async function writeFleetBundle(bundle: unknown): Promise<void> {
  const p = path.join(fleetRoot, 'TriMetaverse', 'docs', 'registry', 'init-sync', 'sync-config.json');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(bundle, null, 2), 'utf-8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-config-sync-'));
  fleetRoot = path.join(tmpRoot, 'fleet');
  configDir = path.join(tmpRoot, 'config');
  await fs.mkdir(path.join(fleetRoot, 'TriMetaverse'), { recursive: true });
  await fs.mkdir(path.join(fleetRoot, 'TriCompany'), { recursive: true });
  resetAppliedCacheForTest();
  // 默认覆盖 = 仅 deepseek（对齐服务器 docker/.env 实际面）
  pinEnv({ DEEPSEEK_API_KEY: 'sk-server-deepseek-only' });
});

afterEach(() => {
  for (const key of COVERAGE_ENV_KEYS) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
  prevEnv = {};
});

describe('config-sync apply — 幂等单调矩阵（§一.4）', () => {
  it('无 bundle 文件 → no-bundle（exit 0 面）', async () => {
    const { git } = scriptedGit();
    const result = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(result.outcome, 'no-bundle');
  });

  it('同 bundleId 重复 apply → no-op（不重落）', async () => {
    await writeFleetBundle(bundleFixture());
    const { git } = scriptedGit(
      { code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' }, // rev-parse HEAD == sourceCommit
    );
    const first = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(first.outcome, 'applied');
    const appliedBefore = await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8');
    const second = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(second.outcome, 'no-op');
    const appliedAfter = await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8');
    assert.equal(appliedBefore, appliedAfter);
  });

  it('更旧 generatedAt 且 contentHash 同 → ignored-stale', async () => {
    await writeFleetBundle(bundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
    const first = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(first.outcome, 'applied');
    // 更旧 bundle（同内容 → 同 hash）
    await writeFleetBundle(bundleFixture({ bundleId: 'bundle-0000', generatedAt: '2026-08-13T10:00:00.000Z' }));
    const second = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(second.outcome, 'ignored-stale');
  });

  it('更旧 generatedAt 但 contentHash 异 → warning-stale + warnings 落盘', async () => {
    await writeFleetBundle(bundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
    const first = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(first.outcome, 'applied');
    await writeFleetBundle(
      bundleFixture({ bundleId: 'bundle-0000', generatedAt: '2026-08-13T10:00:00.000Z', project: { ...bundleFixture().project, repoUrl: 'https://github.com/other/repo.git' } }),
    );
    const second = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(second.outcome, 'warning-stale');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8')) as { warnings?: string[] };
    assert.deepEqual(applied.warnings, ['stale-bundle-content-hash-differs']);
  });

  it('更旧 generatedAt 且 sourceInstanceId 异 → warning-stale（多实例挂起标记）', async () => {
    await writeFleetBundle(bundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
    const first = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(first.outcome, 'applied');
    await writeFleetBundle(
      bundleFixture({ bundleId: 'bundle-0000', generatedAt: '2026-08-13T10:00:00.000Z', generatedBy: 'trilc-init-0.9.0@99999999' }),
    );
    const second = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(second.outcome, 'warning-stale');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8')) as { warnings?: string[] };
    assert.ok(applied.warnings?.includes('stale-bundle-source-instance-differs'));
  });
});

describe('config-sync apply — 落地与降级', () => {
  it('新 bundle → applied：applied.json + 五维文件原子落盘', async () => {
    await writeFleetBundle(bundleFixture());
    const { git, calls } = scriptedGit(
      { code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' },
    );
    const result = await runConfigSyncApply({ fleetRoot, configDir, git, now: () => new Date('2026-08-14T11:00:00.000Z') });
    assert.equal(result.outcome, 'applied');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
    assert.equal(applied.bundleId, 'bundle-0001');
    assert.equal(applied.sourceInstanceId, 'trilc-init-0.9.0@a1b2c3d4');
    assert.equal(applied.lastAppliedAt, '2026-08-14T11:00:00.000Z');
    assert.equal(typeof applied.contentHash, 'string');
    assert.deepEqual(applied.dims, {
      company: 'applied',
      model: 'applied',
      keys: 'applied',
      employees: 'applied',
      project: 'applied',
    });
    for (const dim of ['company', 'model', 'keys', 'employees', 'project']) {
      const dimFile = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', `${dim}.json`), 'utf-8'));
      assert.ok(dimFile, `${dim}.json landed`);
    }
    // 员工维比对只应调用一次 rev-parse（sourceCommit 相等，不触发 pull）
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['-C', path.join(fleetRoot, 'TriCompany'), 'rev-parse', 'HEAD']);
  });

  it('unavailable 维落地：dims 标 unavailable，该维文件写降级段', async () => {
    const bundle = bundleFixture();
    bundle.model = { status: 'unavailable', reason: 'TriModel unreachable' };
    bundle.keys = { status: 'unavailable', reason: 'key cache empty' };
    await writeFleetBundle(bundle);
    const { git } = scriptedGit({ code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
    const result = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(result.outcome, 'applied');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
    assert.equal(applied.dims.model, 'unavailable');
    assert.equal(applied.dims.keys, 'unavailable');
    const modelFile = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'model.json'), 'utf-8'));
    assert.deepEqual(modelFile, { status: 'unavailable', reason: 'TriModel unreachable' });
  });

  it('员工维 sourceCommit 不等 → 同 job 内 ff pull 后复核相等 → applied', async () => {
    await writeFleetBundle(bundleFixture());
    const { git, calls } = scriptedGit(
      { code: 0, stdout: '3333333333333333333333333333333333333333\n', stderr: '' }, // 首次 HEAD ≠ sourceCommit
      { code: 0, stdout: '', stderr: '' }, // pull --ff-only ok
      { code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' }, // 复核 == sourceCommit
    );
    const result = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(result.outcome, 'applied');
    assert.ok(calls.some((c) => c[0] === '-C' && c.includes('pull')));
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
    assert.equal(applied.dims.employees, 'applied');
  });

  it('员工维 pull 后仍不等 → dims.employees=warning + warnings 落盘（§九 fleet 滞后行）', async () => {
    await writeFleetBundle(bundleFixture());
    const { git } = scriptedGit(
      { code: 0, stdout: '3333333333333333333333333333333333333333\n', stderr: '' },
      { code: 1, stdout: '', stderr: 'pull failed: network' },
      { code: 0, stdout: '3333333333333333333333333333333333333333\n', stderr: '' },
    );
    const result = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(result.outcome, 'applied');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
    assert.equal(applied.dims.employees, 'warning');
    assert.ok(applied.warnings?.[0]?.includes('employees:'));
  });
});

describe('config-sync apply — keys 维覆盖判定（i4-4 终审口径：未覆盖 → warning 非 unavailable）', () => {
  it('四 provider 仅 deepseek env 覆盖 → dims.keys=warning + 未覆盖条目明细', async () => {
    const bundle = bundleFixture();
    bundle.keys = {
      providers: [
        { provider: 'deepseek', ready: true, fingerprint: 'a1b2c3d4' },
        { provider: 'anthropic', ready: true, fingerprint: 'b2c3d4e5' },
        { provider: 'openai', ready: true, fingerprint: 'c3d4e5f6' },
        { provider: 'trimetaverse', ready: true, fingerprint: 'd4e5f6a7' },
      ],
      refreshIntervalS: 900,
      fetchedAt: '2026-08-14T09:59:00.000Z',
    };
    await writeFleetBundle(bundle);
    const { git } = scriptedGit({ code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
    const result = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(result.outcome, 'applied');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
    assert.equal(applied.dims.keys, 'warning');
    const keysWarning = applied.warnings?.find((w: string) => w.startsWith('keys:'));
    assert.ok(keysWarning, 'warnings should include keys coverage entry');
    assert.match(keysWarning, /anthropic, openai, trimetaverse/);
    assert.ok(!keysWarning.includes('deepseek'));
    // keys 维文件仍落（配置面 + 指纹，不因未覆盖丢条目）
    const keysFile = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'keys.json'), 'utf-8'));
    assert.equal(keysFile.providers.length, 4);
  });

  it('全部 provider 覆盖 → dims.keys=applied（无 warning 条目）', async () => {
    const bundle = bundleFixture();
    bundle.keys = {
      providers: [{ provider: 'deepseek', ready: true, fingerprint: 'a1b2c3d4' }],
      refreshIntervalS: 900,
      fetchedAt: '2026-08-14T09:59:00.000Z',
    };
    await writeFleetBundle(bundle);
    const { git } = scriptedGit({ code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
    const result = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(result.outcome, 'applied');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
    assert.equal(applied.dims.keys, 'applied');
    assert.ok(!(applied.warnings ?? []).some((w: string) => w.startsWith('keys:')));
  });

  it('opts.env 注入独立于 process.env（零覆盖 → warning）', async () => {
    await writeFleetBundle(bundleFixture());
    const { git } = scriptedGit({ code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
    const result = await runConfigSyncApply({ fleetRoot, configDir, git, env: {} });
    assert.equal(result.outcome, 'applied');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
    assert.equal(applied.dims.keys, 'warning');
    assert.match(applied.warnings?.[0] ?? '', /deepseek/);
  });

  it('keys 维 unavailable 降级段 → dims.keys=unavailable（不受覆盖判定影响）', async () => {
    const bundle = bundleFixture();
    bundle.keys = { status: 'unavailable', reason: 'key cache empty' };
    await writeFleetBundle(bundle);
    const { git } = scriptedGit({ code: 0, stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
    const result = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(result.outcome, 'applied');
    const applied = JSON.parse(await fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
    assert.equal(applied.dims.keys, 'unavailable');
  });
});

describe('config-sync apply — schema 拒绝（服务器侧双保险）', () => {
  it('bundle 含 api_key 明文 → invalid-bundle（不落地）', async () => {
    const bundle = bundleFixture();
    (bundle as unknown as { keys: unknown }).keys = {
      providers: [{ provider: 'deepseek', ready: true, api_key: 'sk-server-side-test' }],
    };
    await writeFleetBundle(bundle);
    const { git } = scriptedGit();
    const result = await runConfigSyncApply({ fleetRoot, configDir, git });
    assert.equal(result.outcome, 'invalid-bundle');
    assert.match(result.detail ?? '', /secret_field_rejected/);
    await assert.rejects(fs.readFile(path.join(configDir, 'init-sync', 'applied.json'), 'utf-8'));
  });

  it('bundle 非 JSON → invalid-bundle', async () => {
    const p = path.join(fleetRoot, 'TriMetaverse', 'docs', 'registry', 'init-sync', 'sync-config.json');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, '{not json', 'utf-8');
    const result = await runConfigSyncApply({ fleetRoot, configDir });
    assert.equal(result.outcome, 'invalid-bundle');
  });
});
