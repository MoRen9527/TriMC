// ── Config Sync apply 执行体（CLI 入口，cron job 经 bash 调起）──
// §三.1 接收侧步骤序：
//   读 fleet 工作树 bundle（不存在 = 无新 bundle，exit 0 no-op）
//   → schema 校验（§一 同规则：拒绝 api_key 白名单外字段，双保险）
//   → 版本比对（applied.json）：同 bundleId no-op / 更旧 generatedAt 忽略
//     / 更旧但 contentHash 异告警 / 更旧但 sourceInstanceId 异告警挂起标记
//     （MVP：记日志 + applied.warnings 呈现）
//   → 员工维 sourceCommit 校验：git -C <fleetRoot>/TriCompany rev-parse HEAD
//     比对，不等 → 同 job 内先 pull --ff-only（fleet 身份）再复核，仍不等
//     → 该维 warning 落地 + 日志（§九 TriCompany fleet 滞后行）
//   → 落地：TRIMC_CONFIG_DIR/init-sync/（applied.json + 各维文件，原子写）
//
// 退出码：0 no-op/成功；非 0（invalid-bundle / 落地失败）→ cron job
// lastError + per-run 日志（既有机制复用）。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  computeContentHash,
  isDimUnavailable,
  validateSyncBundle,
  type AppliedDimStatus,
  type AppliedManifest,
  type DimKey,
  type SyncBundle,
} from './types.js';
import {
  appliedManifestPath,
  createGitRunner,
  defaultConfigDir,
  defaultFleetRoot,
  dimFilePath,
  fleetBundlePath,
  readAppliedManifest,
  type GitRunner,
} from './status.js';

// ── 结果面 ──

export type ConfigSyncApplyOutcome =
  | 'no-bundle'
  | 'no-op'
  | 'applied'
  | 'ignored-stale'
  | 'warning-stale'
  | 'invalid-bundle';

export interface ConfigSyncApplyResult {
  outcome: ConfigSyncApplyOutcome;
  bundleId?: string;
  detail?: string;
}

export interface ConfigSyncApplyOptions {
  fleetRoot?: string;
  configDir?: string;
  git?: GitRunner;
  /** 测试注入：当前时间源。 */
  now?: () => Date;
  /** 测试注入：服务器 env 面（keys 维覆盖判定）；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
}

// ── 原子写（tmp→rename，与生成端同形态）──

async function atomicWriteJson(targetPath: string, payload: unknown): Promise<void> {
  await mkdir(join(targetPath, '..'), { recursive: true });
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  await rename(tmp, targetPath);
}

// ── 版本比对（§一.4 幂等单调矩阵）──

type VersionCompare =
  | { action: 'proceed' }
  | { action: 'no-op' }
  | { action: 'ignore'; detail: string; warning?: string };

function compareWithApplied(
  bundle: SyncBundle,
  contentHash: string,
  applied: AppliedManifest,
): VersionCompare {
  if (bundle.bundleId === applied.bundleId) {
    return { action: 'no-op' };
  }
  const bundleTime = Date.parse(bundle.generatedAt);
  const appliedTime = Date.parse(applied.generatedAt);
  if (Number.isFinite(bundleTime) && Number.isFinite(appliedTime) && bundleTime < appliedTime) {
    // 更旧 generatedAt：忽略；异 hash / 异实例 → 告警（时钟回拨/多机写，MVP 记日志）
    if (contentHash !== applied.contentHash) {
      return {
        action: 'ignore',
        detail: `older generatedAt (${bundle.generatedAt} < ${applied.generatedAt}) with different contentHash — 告警不动作（时钟回拨/多机写，MVP 记日志）`,
        warning: 'stale-bundle-content-hash-differs',
      };
    }
    if (bundle.generatedBy !== applied.sourceInstanceId) {
      return {
        action: 'ignore',
        detail: `older generatedAt from different sourceInstanceId (${bundle.generatedBy} vs ${applied.sourceInstanceId}) — 多实例初始化挂起标记（MVP 记日志）`,
        warning: 'stale-bundle-source-instance-differs',
      };
    }
    return { action: 'ignore', detail: `older generatedAt (${bundle.generatedAt} < ${applied.generatedAt}) — 忽略` };
  }
  return { action: 'proceed' };
}

// ── keys 维覆盖判定（i4-4 终审推导口径 2026-08-14，CTO 小狄）──
// bundle keys 维按本地真源携带（四 provider 指纹 + ready 标志，只带指纹
// 不受收敛影响）；服务器 apply 落地判定 = 仅服务器 env 实际覆盖的 provider
// 落 applied，未覆盖条目落 warning（不落 unavailable——服务器自有材料优先
// §6.7 + bundle 只带指纹的自然推论）。覆盖 = env 变量名存在且非空。

export const PROVIDER_ENV_KEYS: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  trimetaverse: 'TRIMODEL_TRIMETAVERSE_API_KEY',
};

export function resolveKeysDim(
  bundle: SyncBundle,
  env: NodeJS.ProcessEnv = process.env,
): { status: AppliedDimStatus; detail?: string } {
  if (isDimUnavailable(bundle.keys)) {
    return { status: 'unavailable', detail: bundle.keys.reason };
  }
  const uncovered: string[] = [];
  for (const entry of bundle.keys.providers) {
    const envKey = PROVIDER_ENV_KEYS[entry.provider];
    const covered = !!envKey && typeof env[envKey] === 'string' && env[envKey]!.trim().length > 0;
    if (!covered) uncovered.push(entry.provider);
  }
  if (uncovered.length === 0) {
    return { status: 'applied' };
  }
  return {
    status: 'warning',
    detail: `keys providers not covered by server env: ${uncovered.join(', ')}（配置面+指纹已落，材料待 env 提供）`,
  };
}

// ── 员工维 sourceCommit 校验（§三.1 + §九 TriCompany fleet 滞后行）──

async function resolveEmployeesDim(
  bundle: SyncBundle,
  opts: Required<Pick<ConfigSyncApplyOptions, 'fleetRoot' | 'git' | 'now'>> & {
    configDir: string;
  },
): Promise<{ status: AppliedDimStatus; sourceCommit: string | null; detail?: string }> {
  const { fleetRoot, git } = opts;
  const employees = bundle.employees;
  if (isDimUnavailable(employees)) {
    return { status: 'unavailable', sourceCommit: null };
  }
  const triCompanyPath = join(fleetRoot, 'TriCompany');
  let head = '';
  const headRes = await git(['-C', triCompanyPath, 'rev-parse', 'HEAD']);
  if (headRes.code === 0) head = headRes.stdout.trim();

  if (head !== employees.sourceCommit) {
    // 同 job 内先 pull --ff-only（fleet 身份）再复核（§三.1）
    const pullRes = await git(['-C', triCompanyPath, 'pull', '--ff-only'], { timeoutMs: 120_000 });
    const recheck = await git(['-C', triCompanyPath, 'rev-parse', 'HEAD']);
    head = recheck.code === 0 ? recheck.stdout.trim() : head;
    if (head !== employees.sourceCommit) {
      console.log(
        `[trimc:config-sync] employees.sourceCommit mismatch after ff pull (bundle=${employees.sourceCommit}, fleet=${head || 'unavailable'}, pull=${pullRes.code === 0 ? 'ok' : pullRes.stderr}) — 该维 warning 落地（§九 TriCompany fleet 滞后行）`,
      );
      return { status: 'warning', sourceCommit: head, detail: `fleet TriCompany HEAD=${head || 'unavailable'} != bundle ${employees.sourceCommit}` };
    }
    console.log(`[trimc:config-sync] employees.sourceCommit reconciled after ff pull: ${head}`);
  }
  return { status: 'applied', sourceCommit: head };
}

// ── 落地 ──

async function landBundle(
  bundle: SyncBundle,
  contentHash: string,
  dims: Record<DimKey, AppliedDimStatus>,
  warnings: string[],
  configDir: string,
  now: Date,
): Promise<void> {
  const manifest: AppliedManifest = {
    schemaVersion: 1,
    bundleId: bundle.bundleId,
    generatedAt: bundle.generatedAt,
    contentHash,
    sourceInstanceId: bundle.generatedBy,
    lastAppliedAt: now.toISOString(),
    dims,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  await atomicWriteJson(appliedManifestPath(configDir), manifest);
  for (const dim of Object.keys(dims) as DimKey[]) {
    const value = bundle[dim];
    await atomicWriteJson(dimFilePath(configDir, dim), value);
  }
}

// ── apply 执行体 ──

export async function runConfigSyncApply(opts?: ConfigSyncApplyOptions): Promise<ConfigSyncApplyResult> {
  const fleetRoot = opts?.fleetRoot ?? defaultFleetRoot();
  const configDir = opts?.configDir ?? defaultConfigDir();
  const git = opts?.git ?? createGitRunner();
  const now = opts?.now ?? (() => new Date());

  // 1. 读 fleet 工作树 bundle（不存在 = 无新 bundle，exit 0 no-op）
  const bundlePath = fleetBundlePath(fleetRoot);
  let raw: string;
  try {
    raw = await readFile(bundlePath, 'utf-8');
  } catch {
    return { outcome: 'no-bundle' };
  }

  // 2. parse + schema 校验（§一 同规则：递归密钥字段拒绝 + keys 白名单）
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: 'invalid-bundle', detail: 'fleet bundle is not valid JSON' };
  }
  const validation = validateSyncBundle(parsed);
  if (!validation.ok) {
    return { outcome: 'invalid-bundle', detail: `${validation.error}: ${validation.message}` };
  }
  const bundle = validation.bundle;
  const contentHash = computeContentHash(bundle);

  // 3. 版本比对（forceFresh：apply 是写前比对，必须绕 mtime 轻缓存读新鲜帧）
  const applied = await readAppliedManifest(configDir, { forceFresh: true });
  if (applied) {
    const cmp = compareWithApplied(bundle, contentHash, applied);
    if (cmp.action === 'no-op') {
      return { outcome: 'no-op', bundleId: bundle.bundleId, detail: `bundle ${bundle.bundleId} already applied` };
    }
    if (cmp.action === 'ignore') {
      console.log(`[trimc:config-sync] ${cmp.detail}`);
      if (cmp.warning) {
        // MVP 告警呈现：写入 applied.json warnings（不重落各维文件）
        await atomicWriteJson(appliedManifestPath(configDir), {
          ...applied,
          warnings: [...(applied.warnings ?? []), cmp.warning],
        });
        return { outcome: 'warning-stale', bundleId: bundle.bundleId, detail: cmp.detail };
      }
      return { outcome: 'ignored-stale', bundleId: bundle.bundleId, detail: cmp.detail };
    }
  }

  // 4. 员工维 sourceCommit 校验（§三.1；fleet TriCompany 拉齐再复核）
  const dims: Record<DimKey, AppliedDimStatus> = {
    company: isDimUnavailable(bundle.company) ? 'unavailable' : 'applied',
    model: isDimUnavailable(bundle.model) ? 'unavailable' : 'applied',
    keys: 'applied',
    employees: 'applied',
    project: isDimUnavailable(bundle.project) ? 'unavailable' : 'applied',
  };
  const warnings: string[] = [];
  // keys 维覆盖判定（i4-4 终审口径：未覆盖 provider → warning 非 unavailable）
  const keysRes = resolveKeysDim(bundle, opts?.env ?? process.env);
  dims.keys = keysRes.status;
  if (keysRes.detail && keysRes.status === 'warning') warnings.push(`keys: ${keysRes.detail}`);
  const employeesRes = await resolveEmployeesDim(bundle, { fleetRoot, configDir, git, now });
  dims.employees = employeesRes.status;
  if (employeesRes.detail) warnings.push(`employees: ${employeesRes.detail}`);

  // 5. 落地（applied.json + 各维文件，原子写）
  await landBundle(bundle, contentHash, dims, warnings, configDir, now());
  console.log(
    `[trimc:config-sync] applied bundle ${bundle.bundleId} (generatedAt=${bundle.generatedAt}, dims=${JSON.stringify(dims)})`,
  );
  return {
    outcome: 'applied',
    bundleId: bundle.bundleId,
    detail: `landed ${Object.keys(dims).filter((d) => dims[d as DimKey] === 'applied').length}/5 dims applied`,
  };
}
