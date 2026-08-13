/**
 * command-handler tests — mock spawn paths:
 * success / non-zero exit / timeout / runAs argument shape / payload validation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  createCommandHandler,
  type CommandJobPayload,
} from '../../src/cron/command-handler.js';
import { computeWeekShiftTokens } from '../../src/cron/week-math.js';
import type { CronJob } from '@tricompany/agent-core';

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  killCalls: string[];
  kill(signal?: string): boolean;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal?: string) => {
    child.killCalls.push(signal ?? '');
    return true;
  };
  return child;
}

interface CapturedSpawn {
  cmd: string;
  args: string[];
  options: SpawnOptions;
}

function makeJob(payload: CommandJobPayload): CronJob {
  return {
    id: 'job-1',
    name: 'test-job',
    enabled: true,
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: payload as unknown as Record<string, unknown>,
    staggerMs: 0,
    state: {
      nextRunAtMs: null,
      runningAtMs: null,
      lastRunAtMs: null,
      lastRunStatus: null,
      lastError: null,
      consecutiveErrors: 0,
      lastDurationMs: null,
      runCount: 0,
    },
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
}

describe('command-handler', () => {
  let captured: CapturedSpawn[];
  let fakeChild: FakeChild;

  beforeEach(() => {
    captured = [];
    fakeChild = createFakeChild();
  });

  function makeHandler(logToFiles = false) {
    return createCommandHandler({
      logDir: '/tmp/trimc-test-logs',
      spawnFn: ((cmd: string, args: string[], options: SpawnOptions) => {
        captured.push({ cmd, args, options });
        return fakeChild as unknown as ChildProcess;
      }) as typeof import('node:child_process').spawn,
      logToFiles,
    });
  }

  it('succeeds on exit code 0 and replaces week tokens', async () => {
    const tokens = computeWeekShiftTokens();
    const handler = makeHandler();
    const job = makeJob({
      command: 'echo {fromWeek}->{toWeek} start {startDate}',
      cwd: '/srv/fleet',
    });

    const promise = handler(job);
    fakeChild.stdout.emit('data', Buffer.from('shift ok\n'));
    fakeChild.emit('close', 0);
    await promise;

    assert.equal(captured.length, 1);
    assert.equal(captured[0].cmd, '/bin/bash');
    assert.deepEqual(captured[0].args.slice(0, 2), ['-e', '-c']);
    const command = captured[0].args[2];
    assert.ok(!command.includes('{'), `tokens not replaced: ${command}`);
    assert.equal(
      command,
      `echo ${tokens.fromWeek}->${tokens.toWeek} start ${tokens.startDate}`,
    );
    assert.equal(captured[0].options.cwd, '/srv/fleet');
  });

  it('wraps spawn in runuser when payload.runAs is set', async () => {
    const handler = makeHandler();
    const job = makeJob({
      command: 'python3 -m runtime.cognition.weekly_plane_shift --sync',
      cwd: '/srv/fleet',
      runAs: 'fleet',
    });

    const promise = handler(job);
    fakeChild.emit('close', 0);
    await promise;

    assert.equal(captured[0].cmd, 'runuser');
    assert.deepEqual(captured[0].args.slice(0, 4), ['-u', 'fleet', '--', '/bin/bash']);
    assert.equal(captured[0].options.detached, true);
    assert.equal((captured[0].options.env as NodeJS.ProcessEnv).HOME, '/home/fleet');
  });

  it('throws with exit code and stderr tail on non-zero exit', async () => {
    const handler = makeHandler();
    const job = makeJob({ command: 'false', cwd: '/srv/fleet' });

    const promise = handler(job);
    fakeChild.stderr.emit('data', Buffer.from('boom: migration failed\n'));
    fakeChild.emit('close', 1);

    await assert.rejects(promise, /command exited with code 1: boom: migration failed/);
  });

  it('throws on timeout and kills the process group', async () => {
    const handler = makeHandler();
    const job = makeJob({
      command: 'sleep 1000',
      cwd: '/srv/fleet',
      timeoutMs: 50,
    });

    const promise = handler(job);
    await assert.rejects(promise, /command timed out after 50ms/);
    assert.ok(fakeChild.killCalls.includes('SIGKILL'), 'SIGKILL not sent on timeout');
  });

  it('throws on spawn error (missing binary)', async () => {
    const handler = makeHandler();
    const job = makeJob({ command: 'whatever', cwd: '/srv/fleet' });

    const promise = handler(job);
    fakeChild.emit('error', new Error('ENOENT'));
    await assert.rejects(promise, /spawn error: ENOENT/);
  });

  it('rejects payloads without command/cwd', async () => {
    const handler = makeHandler();
    const job = makeJob({ command: '', cwd: '' } as unknown as CommandJobPayload);
    await assert.rejects(handler(job), /requires string fields: command, cwd/);
  });
});
