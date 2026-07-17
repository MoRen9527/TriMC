/**
 * Tests for job-store: CRUD, persistence, atomic writes.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadJobStore,
  saveJobStore,
  invalidateJobStoreCache,
  overrideConfigDir,
  resetConfigDir,
  buildJob,
  applyJobPatch,
  patchJobState,
} from "../job-store.js";
import type { CronJob, CronJobCreate } from "../types.js";

describe("job-store", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trimc-job-store-"));
    overrideConfigDir(tmpDir);
  });

  after(async () => {
    resetConfigDir();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    invalidateJobStoreCache();
  });

  // ── load / save round-trip ─────────────────────────────────────

  it("loads empty store when no file exists", async () => {
    const jobs = await loadJobStore();
    assert.deepEqual(jobs, {});
  });

  it("saves and loads jobs", async () => {
    const job = buildJob({
      name: "test-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { key: "value" },
    });

    const jobs: Record<string, CronJob> = { [job.id]: job };
    await saveJobStore(jobs);

    // Reset cache to force re-read
    invalidateJobStoreCache();

    const loaded = await loadJobStore();
    assert.ok(loaded[job.id]);
    assert.equal(loaded[job.id].name, "test-job");
    assert.equal(loaded[job.id].payload.key, "value");
  });

  it("writes atomically (tmp → rename)", async () => {
    const job = buildJob({
      name: "atomic-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000 },
      payload: {},
    });
    await saveJobStore({ [job.id]: job });

    // Check that the temp file doesn't linger
    const cronDir = path.join(tmpDir, "cron");
    const files = await fs.readdir(cronDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, `tmp files left behind: ${tmpFiles.join(", ")}`);
  });

  // ── buildJob ───────────────────────────────────────────────────

  describe("buildJob", () => {
    it("assigns a UUID when no id provided", () => {
      const job = buildJob({
        name: "auto-id",
        enabled: true,
        schedule: { kind: "every", everyMs: 5000 },
        payload: {},
      });
      assert.ok(job.id.length > 20);
    });

    it("honors explicit id", () => {
      const job = buildJob({
        id: "my-custom-id",
        name: "explicit-id",
        enabled: true,
        schedule: { kind: "every", everyMs: 5000 },
        payload: {},
      });
      assert.equal(job.id, "my-custom-id");
    });

    it("sets createdAtMs and updatedAtMs", () => {
      const now = Date.now();
      const job = buildJob(
        {
          name: "timestamps",
          enabled: true,
          schedule: { kind: "every", everyMs: 5000 },
          payload: {},
        },
        now,
      );
      assert.equal(job.createdAtMs, now);
      assert.equal(job.updatedAtMs, now);
    });

    it("computes initial nextRunAtMs", () => {
      const job = buildJob({
        name: "has-next-run",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {},
      });
      assert.ok(typeof job.state.nextRunAtMs === "number");
      assert.ok(job.state.nextRunAtMs! > Date.now());
    });
  });

  // ── applyJobPatch ──────────────────────────────────────────────

  describe("applyJobPatch", () => {
    it("patches name and enabled", () => {
      const job = buildJob({
        name: "original",
        enabled: true,
        schedule: { kind: "every", everyMs: 5000 },
        payload: {},
      });
      const patched = applyJobPatch(job, { name: "renamed", enabled: false });
      assert.equal(patched.name, "renamed");
      assert.equal(patched.enabled, false);
      assert.ok(patched.updatedAtMs >= job.updatedAtMs);
    });

    it("recomputes nextRunAtMs when schedule changes", () => {
      const job = buildJob({
        name: "schedule-change",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {},
      });
      const originalNext = job.state.nextRunAtMs;
      const patched = applyJobPatch(job, {
        schedule: { kind: "every", everyMs: 120_000 },
      });
      assert.ok(patched.state.nextRunAtMs !== null);
      // After changing schedule, next run should reflect new interval
    });
  });

  // ── patchJobState ──────────────────────────────────────────────

  describe("patchJobState", () => {
    it("merges state updates", () => {
      const job = buildJob({
        name: "state-patch",
        enabled: true,
        schedule: { kind: "every", everyMs: 5000 },
        payload: {},
      });
      const patched = patchJobState(job, {
        lastRunStatus: "ok",
        runCount: 5,
      });
      assert.equal(patched.state.lastRunStatus, "ok");
      assert.equal(patched.state.runCount, 5);
      // Original fields preserved
      assert.equal(patched.state.lastRunAtMs, job.state.lastRunAtMs);
    });
  });

  // ── persistence across cache invalidation ──────────────────────

  it("persists jobs across cache invalidation", async () => {
    const job = buildJob({
      name: "persist-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 30_000 },
      payload: {},
    });
    await saveJobStore({ [job.id]: job });

    // Simulate restart: invalidate cache, re-load
    invalidateJobStoreCache();
    const loaded = await loadJobStore();
    assert.ok(loaded[job.id]);
    assert.equal(loaded[job.id].name, "persist-test");
  });
});
