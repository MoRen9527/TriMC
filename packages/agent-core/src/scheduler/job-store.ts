/**
 * Job Store — JSON-file persistence with atomic writes.
 * Absorbed from openclaw cron/store.ts, simplified:
 *   - No backup comparison for runtime-only changes (MVP scope)
 *   - No migration/normalization (fresh start)
 *   - No "noisy" field filtering
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronStoreFile,
} from "./types.js";
import {
  CRON_STORE_SCHEMA,
  CRON_STORE_VERSION,
  newCronJobState,
} from "./types.js";
import { computeInitialNextRunAtMs } from "./cron-engine.js";
import { resolveDefaultCronStagger } from "./stagger.js";

// ── path resolution ──────────────────────────────────────────────

let memoizedConfigDir: string | null = null;

function resolveConfigDir(): string {
  if (memoizedConfigDir) return memoizedConfigDir;
  // XDG-style: $TRIMC_CONFIG_DIR or ./data
  const env = process.env.TRIMC_CONFIG_DIR;
  memoizedConfigDir = env ?? path.resolve(process.cwd(), "data");
  return memoizedConfigDir;
}

function storeFilePath(): string {
  return path.join(resolveConfigDir(), "cron", "jobs.json");
}

/** Override config dir (for tests). */
export function overrideConfigDir(dir: string): void {
  memoizedConfigDir = dir;
}

/** Reset memoization. */
export function resetConfigDir(): void {
  memoizedConfigDir = null;
}

// ── atomic write ─────────────────────────────────────────────────

const WRITE_TMP_SUFFIX = ".tmp";
const WRITE_BAK_SUFFIX = ".bak";

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function renameWithRetry(
  src: string,
  dst: string,
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.rename(src, dst);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // EBUSY / EPERM on Windows, EEXIST on some Linux kernels
      if (attempt < maxRetries && (code === "EBUSY" || code === "EPERM" || code === "EEXIST")) {
        await new Promise((r) => setTimeout(r, 10 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ── load / save ──────────────────────────────────────────────────

let memCache: Record<string, CronJob> | null = null;

function emptyStoreFile(): CronStoreFile {
  return {
    $schema: CRON_STORE_SCHEMA,
    version: CRON_STORE_VERSION,
    jobs: {},
  };
}

export async function loadJobStore(): Promise<Record<string, CronJob>> {
  if (memCache) return memCache;

  const filePath = storeFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidStoreFile(parsed)) {
      console.warn("[job-store] invalid store file, starting fresh");
      memCache = {};
      return memCache;
    }
    memCache = parsed.jobs;
    return memCache;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      memCache = {};
      return memCache;
    }
    console.warn("[job-store] failed to load, starting fresh:", (err as Error).message);
    memCache = {};
    return memCache;
  }
}

export async function saveJobStore(
  jobs: Record<string, CronJob>,
): Promise<void> {
  const filePath = storeFilePath();
  await ensureDir(filePath);

  const storeFile: CronStoreFile = {
    $schema: CRON_STORE_SCHEMA,
    version: CRON_STORE_VERSION,
    jobs,
  };

  const tmpPath = filePath + WRITE_TMP_SUFFIX;
  const bakPath = filePath + WRITE_BAK_SUFFIX;

  // 1. Write to tmp
  await fs.writeFile(tmpPath, JSON.stringify(storeFile, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });

  // 2. Backup current
  try {
    await fs.copyFile(filePath, bakPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw err; // no existing file to backup = fine
  }

  // 3. Atomic rename
  await renameWithRetry(tmpPath, filePath);

  // 4. Update cache
  memCache = jobs;
}

/** Invalidate the in-memory cache (forces re-read on next load). */
export function invalidateJobStoreCache(): void {
  memCache = null;
}

// ── validation ───────────────────────────────────────────────────

function isValidStoreFile(value: unknown): value is CronStoreFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.$schema === "string" &&
    typeof v.version === "number" &&
    typeof v.jobs === "object" &&
    v.jobs !== null
  );
}

// ── CRUD helpers ─────────────────────────────────────────────────

export function buildJob(create: CronJobCreate, nowMs?: number): CronJob {
  const now = nowMs ?? Date.now();
  const id = create.id ?? randomUUID();
  const staggerMs =
    create.staggerMs !== undefined
      ? create.staggerMs
      : create.schedule.kind === "cron"
        ? resolveDefaultCronStagger(create.schedule.cron)
        : 0;
  const state = newCronJobState();
  state.nextRunAtMs = computeInitialNextRunAtMs(create.schedule, staggerMs);

  return {
    ...create,
    id,
    staggerMs,
    state,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

export function applyJobPatch(job: CronJob, patch: CronJobPatch): CronJob {
  const updated: CronJob = { ...job };

  if (patch.name !== undefined) updated.name = patch.name;
  if (patch.description !== undefined) updated.description = patch.description;
  if (patch.enabled !== undefined) updated.enabled = patch.enabled;
  if (patch.schedule !== undefined) {
    updated.schedule = patch.schedule;
    updated.state.nextRunAtMs = computeInitialNextRunAtMs(
      patch.schedule,
      updated.staggerMs,
    );
  }
  if (patch.payload !== undefined) updated.payload = patch.payload;
  if (patch.staggerMs !== undefined) updated.staggerMs = patch.staggerMs;

  updated.updatedAtMs = Date.now();
  return updated;
}

export function patchJobState(
  job: CronJob,
  stateUpdates: Partial<CronJob["state"]>,
): CronJob {
  return {
    ...job,
    state: { ...job.state, ...stateUpdates },
    updatedAtMs: Date.now(),
  };
}
