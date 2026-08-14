// ── Config Sync status 读取器（磁盘真源，只读）──
// GET /internal/v1/config/sync/status 数据源（§三.3）：
//   applied  ← TRIMC_CONFIG_DIR/init-sync/applied.json（磁盘真源，无跨进程 IPC）
//   fleetHead ← git -C <fleetRoot>/TriMetaverse rev-parse HEAD（只读）
//   pending  ← fleet 工作树 bundle 与 applied 版本差（同步未达呈现代理）
//   dims     ← applied.dims（协同确认 §七 服务器侧事实源）
//
// 消费面解析口径（D3）：applied 文件 mtime 轻量缓存（TTL ≤ 10s），
// 不建跨进程内存热更新通道——cron job 是独立进程，文件即真源、
// 服务器读取时解析。

import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  validateSyncBundle,
  type AppliedManifest,
  type SyncStatusPayload,
} from './types.js';

// ── 路径面 ──

/** fleet 根（TriMetaverse/TriCompany fleet clone 同根；默认 /srv/fleet，测试注入）。 */
export function defaultFleetRoot(): string {
  return process.env.TRIMC_FLEET_ROOT ?? '/srv/fleet';
}

/** 配置面根（applied.json 落点；默认与 cron job-store 同根 $TRIMC_CONFIG_DIR）。 */
export function defaultConfigDir(): string {
  return process.env.TRIMC_CONFIG_DIR ?? resolve('data');
}

/** fleet 工作树 bundle 路径（生成端写入对象，§一落点）。 */
export function fleetBundlePath(fleetRoot: string): string {
  return join(fleetRoot, 'TriMetaverse', 'docs', 'registry', 'init-sync', 'sync-config.json');
}

export function initSyncDir(configDir: string): string {
  return join(configDir, 'init-sync');
}

export function appliedManifestPath(configDir: string): string {
  return join(initSyncDir(configDir), 'applied.json');
}

export function dimFilePath(configDir: string, dim: string): string {
  return join(initSyncDir(configDir), `${dim}.json`);
}

// ── git 只读执行器（fleet 单身份；服务器侧一切 git = fleet，OBS-20260814-002）──

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<GitExecResult>;

export function createGitRunner(): GitRunner {
  return (args, opts) =>
    new Promise((resolvePromise) => {
      execFile(
        'git',
        args,
        {
          cwd: opts?.cwd,
          timeout: opts?.timeoutMs ?? 30_000,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          // HOME 兜底：systemd 服务 env 可能无 HOME（如 trimc.service），git 读不到
          // 用户级 config（safe.directory 例外）→ fleet 属主仓「dubious ownership」
          // exit 128（i4-2 部署实证发现）。补 HOME 后 git 正常读 ~/.gitconfig。
          env: { ...process.env, HOME: process.env.HOME || homedir() },
        },
        (error, stdout, stderr) => {
          if (error) {
            const errCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
            const code = typeof errCode === 'number' ? errCode : -1;
            resolvePromise({
              code,
              stdout: String(stdout),
              stderr: `${(error as Error).message} ${String(stderr)}`.trim(),
            });
          } else {
            resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          }
        },
      );
    });
}

// ── applied.json 读取（mtime 轻缓存，TTL ≤ 10s，D3）──

interface AppliedCacheEntry {
  mtimeMs: number;
  readAtMs: number;
  manifest: AppliedManifest | null;
}

let _appliedCache: { path: string; entry: AppliedCacheEntry } | null = null;

const APPLIED_CACHE_TTL_MS = 10_000;

export function resetAppliedCacheForTest(): void {
  _appliedCache = null;
}

export async function readAppliedManifest(
  configDir: string,
  opts?: { forceFresh?: boolean },
): Promise<AppliedManifest | null> {
  const path = appliedManifestPath(configDir);
  let st;
  try {
    st = await stat(path);
  } catch {
    _appliedCache = null;
    return null;
  }
  if (
    !opts?.forceFresh &&
    _appliedCache &&
    _appliedCache.path === path &&
    _appliedCache.entry.mtimeMs === st.mtimeMs &&
    Date.now() - _appliedCache.entry.readAtMs < APPLIED_CACHE_TTL_MS
  ) {
    return _appliedCache.entry.manifest;
  }
  let manifest: AppliedManifest | null = null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppliedManifest>;
    if (typeof parsed.bundleId === 'string' && typeof parsed.generatedAt === 'string') {
      manifest = parsed as AppliedManifest;
    }
  } catch {
    manifest = null;
  }
  _appliedCache = { path, entry: { mtimeMs: st.mtimeMs, readAtMs: Date.now(), manifest } };
  return manifest;
}

// ── status 载荷组装 ──

export interface SyncStatusOptions {
  fleetRoot?: string;
  configDir?: string;
  git?: GitRunner;
}

export async function readConfigSyncStatus(opts?: SyncStatusOptions): Promise<SyncStatusPayload> {
  const fleetRoot = opts?.fleetRoot ?? defaultFleetRoot();
  const configDir = opts?.configDir ?? defaultConfigDir();
  const git = opts?.git ?? createGitRunner();

  const applied = await readAppliedManifest(configDir);

  // fleetHead（只读；git 失败 = null——status 端点不因 git 面故障 500）
  let fleetHead: SyncStatusPayload['fleetHead'] = null;
  try {
    const [headRes, branchRes] = await Promise.all([
      git(['-C', join(fleetRoot, 'TriMetaverse'), 'rev-parse', 'HEAD']),
      git(['-C', join(fleetRoot, 'TriMetaverse'), 'rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    if (headRes.code === 0 && headRes.stdout.trim()) {
      fleetHead = {
        branch: branchRes.code === 0 ? branchRes.stdout.trim() : 'detached',
        commit: headRes.stdout.trim(),
      };
    } else {
      console.warn(
        `[trimc:config-sync] fleetHead git failed (head.code=${headRes.code}, branch.code=${branchRes.code}): ${headRes.stderr} / ${branchRes.stderr}`,
      );
    }
  } catch (err) {
    console.warn(`[trimc:config-sync] fleetHead git threw: ${(err as Error).message}`);
    fleetHead = null;
  }

  // pending：fleet 工作树 bundle 与 applied 版本差（同步未达呈现代理）
  let pending: SyncStatusPayload['pending'] = null;
  try {
    const raw = await readFile(fleetBundlePath(fleetRoot), 'utf-8');
    const validation = validateSyncBundle(JSON.parse(raw));
    if (validation.ok) {
      const bundle = validation.bundle;
      if (!applied || bundle.bundleId !== applied.bundleId) {
        pending = { bundleId: bundle.bundleId, generatedAt: bundle.generatedAt };
      }
    }
  } catch {
    pending = null;
  }

  return {
    ok: true,
    applied: applied
      ? {
          bundleId: applied.bundleId,
          generatedAt: applied.generatedAt,
          lastAppliedAt: applied.lastAppliedAt,
          sourceInstanceId: applied.sourceInstanceId,
        }
      : null,
    fleetHead,
    dims: applied?.dims ?? null,
    pending,
    warnings: applied?.warnings ?? [],
  };
}
