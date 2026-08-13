/**
 * service tests — CRUD / runJob force semantics / stale-run recovery /
 * degraded aggregation / log listing. Uses a temp config dir and an
 * injected no-op handler (no real commands run).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  overrideConfigDir,
  resetConfigDir,
  invalidateJobStoreCache,
  loadJobStore,
  saveJobStore,
  patchJobState,
  type CronJobCreate,
} from '@tricompany/agent-core';
import { createCronService, type CronService } from '../../src/cron/service.js';

/** Far-future schedule so the executor loop never fires it during tests. */
const FAR_FUTURE: CronJobCreate['schedule'] = { kind: 'at', atMs: 4_000_000_000_000 };

function makeCreate(name: string, enabled = true): CronJobCreate {
  return {
    name,
    enabled,
    schedule: FAR_FUTURE,
    payload: { command: `echo ${name}`, cwd: '/tmp' },
  };
}

describe('cron service', () => {
  let tmpDir: string;
  let logDir: string;
  let service: CronService;
  const handlerCalls: string[] = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-cron-svc-'));
    logDir = path.join(tmpDir, 'cron', 'logs');
    handlerCalls.length = 0;
    overrideConfigDir(tmpDir);
    invalidateJobStoreCache();
    service = createCronService({
      logDir,
      handler: async (job) => {
        handlerCalls.push(job.name);
      },
    });
  });

  afterEach(() => {
    service.stop();
    resetConfigDir();
    invalidateJobStoreCache();
  });

  it('addJob / listJobs / getJob / removeJob round-trip', async () => {
    const job = await service.addJob(makeCreate('job-a'));
    assert.ok(job.id);
    assert.equal((await service.getJob(job.id))?.name, 'job-a');
    assert.equal((await service.listJobs()).length, 1);

    assert.equal(await service.removeJob(job.id), true);
    assert.equal(await service.removeJob(job.id), false);
    assert.equal(await service.getJob(job.id), null);
    assert.equal((await service.listJobs()).length, 0);
  });

  it('updateJob patches enabled/name and returns null for unknown id', async () => {
    const job = await service.addJob(makeCreate('job-b'));
    const updated = await service.updateJob(job.id, { enabled: false, name: 'job-b2' });
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.name, 'job-b2');
    assert.equal(await service.updateJob('missing', { enabled: true }), null);
  });

  it('runJob: disabled refused unless force, running refused always', async () => {
    const job = await service.addJob(makeCreate('job-c', false));

    const refused = await service.runJob(job.id);
    assert.deepEqual({ ok: refused.ok, ran: refused.ran, reason: refused.reason }, {
      ok: true,
      ran: false,
      reason: 'disabled',
    });

    const forced = await service.runJob(job.id, true);
    assert.equal(forced.ran, true);
    assert.equal(forced.reason, 'status=ok');
    assert.deepEqual(handlerCalls, ['job-c']);

    const missing = await service.runJob('nope');
    assert.deepEqual({ ok: missing.ok, ran: missing.ran, reason: missing.reason }, {
      ok: false,
      ran: false,
      reason: 'not-found',
    });
  });

  it('runJob: already-running refused', async () => {
    const job = await service.addJob(makeCreate('job-d'));
    const jobs = await loadJobStore();
    jobs[job.id] = patchJobState(jobs[job.id], { runningAtMs: Date.now() });
    await saveJobStore(jobs);

    const result = await service.runJob(job.id);
    assert.deepEqual({ ok: result.ok, ran: result.ran, reason: result.reason }, {
      ok: true,
      ran: false,
      reason: 'already-running',
    });
  });

  it('runJob failure records lastError and consecutiveErrors; success resets', async () => {
    const failing = createCronService({
      logDir,
      handler: async () => {
        throw new Error('migration exploded');
      },
    });
    const job = await failing.addJob(makeCreate('job-e'));

    const r1 = await failing.runJob(job.id);
    assert.equal(r1.ran, true);
    assert.ok(r1.reason?.startsWith('error: migration exploded'));

    let stored = await failing.getJob(job.id);
    assert.equal(stored?.state.lastRunStatus, 'error');
    assert.equal(stored?.state.consecutiveErrors, 1);
    assert.ok(stored?.state.lastError?.includes('migration exploded'));

    // success resets consecutiveErrors
    const okService = createCronService({
      logDir,
      handler: async () => {
        /* ok */
      },
    });
    const okJob = await okService.addJob(makeCreate('job-f'));
    await okService.runJob(okJob.id);
    stored = await okService.getJob(okJob.id);
    assert.equal(stored?.state.lastRunStatus, 'ok');
    assert.equal(stored?.state.runCount, 1);
    assert.equal(stored?.state.runningAtMs, null);
  });

  it('start() resets stale runningAtMs (crash recovery)', async () => {
    const job = await service.addJob(makeCreate('job-g'));
    const jobs = await loadJobStore();
    jobs[job.id] = patchJobState(jobs[job.id], { runningAtMs: Date.now() });
    await saveJobStore(jobs);

    await service.start();
    const stored = await service.getJob(job.id);
    assert.equal(stored?.state.runningAtMs, null, 'stale runningAtMs not reset');
    assert.ok(service.stop);
  });

  it('degraded after 3 consecutive failures, visible in getStatus', async () => {
    const failing = createCronService({
      logDir,
      handler: async () => {
        throw new Error('boom');
      },
    });
    const job = await failing.addJob(makeCreate('job-h'));

    for (let i = 0; i < 3; i++) {
      await failing.runJob(job.id);
    }
    const status = await failing.getStatus();
    assert.equal(status.degraded, true);
    assert.equal(status.consecutiveFailures, 3);
    assert.equal(status.jobCount, 1);
  });

  it('getLogs lists parsed per-run log files, newest first', async () => {
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(
      path.join(logDir, 'job-x__2026-08-16T15-00-00-000Z.log'),
      [
        'job: job-x (job-x)',
        'startedAt: 2026-08-16T15:00:00.000Z',
        '',
        '── stdout ──',
        'shift ok',
        '',
        '── stderr ──',
        '(no stderr)',
        '',
        'RESULT: exit code 0',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(logDir, 'job-x__2026-08-17T15-00-00-000Z.log'),
      [
        'job: job-x (job-x)',
        'startedAt: 2026-08-17T15:00:00.000Z',
        '',
        '── stdout ──',
        '',
        '── stderr ──',
        'migration failed: source not found',
        '',
        'RESULT: exit code 1',
      ].join('\n'),
    );

    const logs = await service.getLogs('job-x');
    assert.equal(logs.length, 2);
    assert.equal(logs[0].startedAt, '2026-08-17T15:00:00.000Z', 'newest first');
    assert.equal(logs[0].status, 'error');
    assert.equal(logs[0].errorMessage, 'migration failed: source not found');
    assert.equal(logs[1].status, 'ok');
    assert.equal(logs[1].errorMessage, null);

    const filtered = await service.getLogs('other');
    assert.equal(filtered.length, 0);
  });
});
