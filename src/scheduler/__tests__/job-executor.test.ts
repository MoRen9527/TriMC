/**
 * Tests for job-executor: scheduling loop, execution, rescheduling.
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
} from "../job-store.js";
import { JobExecutor } from "../job-executor.js";
import type { CronJob } from "../types.js";

describe("job-executor", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trimc-executor-"));
    overrideConfigDir(tmpDir);
  });

  after(async () => {
    resetConfigDir();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    invalidateJobStoreCache();
  });

  // ── lifecycle ──────────────────────────────────────────────────

  it("starts and stops cleanly", () => {
    const executor = new JobExecutor(async () => {});
    assert.equal(executor.isRunning, false);
    executor.start();
    assert.equal(executor.isRunning, true);
    executor.stop();
    assert.equal(executor.isRunning, false);
  });

  it("double-start is a no-op", () => {
    const executor = new JobExecutor(async () => {});
    executor.start();
    executor.start();
    assert.equal(executor.isRunning, true);
    executor.stop();
  });

  // ── job execution ──────────────────────────────────────────────

  it("executes due jobs", async () => {
    const executedIds: string[] = [];
    const executor = new JobExecutor(async (job) => {
      executedIds.push(job.id);
    });

    // Create a job due "now" (every schedule with small interval)
    const job = buildJob({
      name: "fire-immediately",
      enabled: true,
      schedule: { kind: "every", everyMs: 100 }, // fires every 100ms
      payload: {},
    });
    // Force nextRunAtMs to be in the past
    job.state.nextRunAtMs = Date.now() - 1;

    await saveJobStore({ [job.id]: job });

    executor.start();

    // Wait for execution
    await new Promise((r) => setTimeout(r, 500));

    executor.stop();

    assert.ok(
      executedIds.includes(job.id),
      `Expected job ${job.id} to execute, got: ${executedIds.join(", ")}`,
    );
  });

  it("respects enabled: false", async () => {
    const executedIds: string[] = [];
    const executor = new JobExecutor(async (job) => {
      executedIds.push(job.id);
    });

    const job = buildJob({
      name: "disabled-job",
      enabled: false,
      schedule: { kind: "every", everyMs: 100 },
      payload: {},
    });
    job.state.nextRunAtMs = Date.now() - 1;

    await saveJobStore({ [job.id]: job });

    executor.start();
    await new Promise((r) => setTimeout(r, 300));
    executor.stop();

    assert.equal(executedIds.includes(job.id), false);
  });

  // ── state update after execution ───────────────────────────────

  it("updates runCount and lastRunStatus after execution", async () => {
    const executor = new JobExecutor(async () => {
      // successful execution
    });

    const job = buildJob({
      name: "state-check",
      enabled: true,
      schedule: { kind: "every", everyMs: 100 },
      payload: {},
    });
    job.state.nextRunAtMs = Date.now() - 1;

    await saveJobStore({ [job.id]: job });

    executor.start();
    await new Promise((r) => setTimeout(r, 500));
    executor.stop();

    // Re-read from store
    invalidateJobStoreCache();
    const loaded = await loadJobStore();
    const updated = loaded[job.id];
    assert.ok(updated, "job should still exist");
    assert.ok(updated.state.runCount >= 1, `runCount=${updated.state.runCount}`);
    assert.equal(updated.state.lastRunStatus, "ok");
    assert.equal(updated.state.runningAtMs, null, "should not be stuck running");
    assert.ok(
      typeof updated.state.lastDurationMs === "number" &&
        updated.state.lastDurationMs !== null,
    );
  });

  it("records error status on handler failure", async () => {
    const executor = new JobExecutor(async () => {
      throw new Error("boom");
    });

    const job = buildJob({
      name: "error-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 100 },
      payload: {},
    });
    job.state.nextRunAtMs = Date.now() - 1;

    await saveJobStore({ [job.id]: job });

    executor.start();
    await new Promise((r) => setTimeout(r, 500));
    executor.stop();

    invalidateJobStoreCache();
    const loaded = await loadJobStore();
    const updated = loaded[job.id];
    assert.equal(updated.state.lastRunStatus, "error");
    assert.ok(updated.state.lastError?.includes("boom"));
    assert.ok(updated.state.consecutiveErrors >= 1);
  });

  // ── rescheduling ───────────────────────────────────────────────

  it("computes nextRunAtMs after execution", async () => {
    const executor = new JobExecutor(async () => {});

    const job = buildJob({
      name: "reschedule-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 3600_000 }, // 1 hour
      payload: {},
    });
    const originalNext = job.state.nextRunAtMs;
    job.state.nextRunAtMs = Date.now() - 1; // force immediate

    await saveJobStore({ [job.id]: job });

    executor.start();
    await new Promise((r) => setTimeout(r, 500));
    executor.stop();

    invalidateJobStoreCache();
    const loaded = await loadJobStore();
    const updated = loaded[job.id];
    assert.ok(updated.state.nextRunAtMs !== null);
    assert.ok(updated.state.nextRunAtMs! > Date.now(), "next run should be in the future");
  });
});
