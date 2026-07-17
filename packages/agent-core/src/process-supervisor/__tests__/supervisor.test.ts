import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessSupervisor } from '../supervisor.js';
import type { ProcessSupervisor, ManagedRun, RunExit } from '../types.js';

// Helper: spawn a short-lived echo process
function echoInput(argv: string[]): string[] {
  // node -e "..." prints to stdout and exits
  return ['node', '-e', argv.join(' ')];
}

describe('ProcessSupervisor', () => {
  let supervisor: ProcessSupervisor;
  let runs: ManagedRun[];

  beforeEach(() => {
    supervisor = createProcessSupervisor();
    runs = [];
  });

  afterEach(async () => {
    // Cancel any remaining runs
    for (const run of runs) {
      try { run.cancel('manual-cancel'); } catch { /* ignore */ }
    }
  });

  const track = (run: ManagedRun): ManagedRun => {
    runs.push(run);
    return run;
  };

  describe('spawn', () => {
    it('spawns a process and returns a ManagedRun with runId', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.log("hello");']),
      }));

      assert.ok(run.runId);
      assert.ok(run.pid);
      assert.ok(run.startedAtMs > 0);
    });

    it('captures stdout', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.log("hello triMC");']),
      }));

      const exit: RunExit = await run.wait();
      assert.ok(exit.stdout.includes('hello triMC'));
    });

    it('captures stderr', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.error("bang");']),
      }));

      const exit: RunExit = await run.wait();
      assert.ok(exit.stderr.includes('bang'));
    });

    it('records exit code 0 for successful process', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['process.exit(0);']),
      }));

      const exit: RunExit = await run.wait();
      assert.equal(exit.exitCode, 0);
      assert.equal(exit.reason, 'exit');
    });

    it('records non-zero exit code', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['process.exit(42);']),
      }));

      const exit: RunExit = await run.wait();
      assert.equal(exit.exitCode, 42);
    });

    it('tracks runId via getRecord', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.log("ok");']),
      }));

      const record = supervisor.getRecord(run.runId);
      assert.ok(record);
      assert.equal(record.runId, run.runId);
      assert.equal(record.state, 'running');
    });

    it('honors explicit runId', async () => {
      const run = track(await supervisor.spawn({
        runId: 'custom-id',
        argv: echoInput(['console.log("ok");']),
      }));

      assert.equal(run.runId, 'custom-id');
    });

    it('rejects when argv is empty', async () => {
      await assert.rejects(
        () => supervisor.spawn({ argv: [] }),
        /spawn argv cannot be empty/,
      );
    });

    it('emits onStdout callback', async () => {
      let received = '';
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.log("stream");']),
        onStdout: (chunk) => { received += chunk; },
      }));

      await run.wait();
      assert.ok(received.includes('stream'));
    });

    it('emits onStderr callback', async () => {
      let received = '';
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.error("err-stream");']),
        onStderr: (chunk) => { received += chunk; },
      }));

      await run.wait();
      assert.ok(received.includes('err-stream'));
    });
  });

  describe('cancel', () => {
    it('cancel() terminates a running process', async () => {
      // Start a long-running process
      const run = track(await supervisor.spawn({
        argv: echoInput(['setTimeout(() => {}, 30000);']),
      }));

      run.cancel('manual-cancel');

      const exit: RunExit = await run.wait();
      assert.equal(exit.reason, 'manual-cancel');
    });

    it('top-level cancel() terminates the process', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['setTimeout(() => {}, 30000);']),
      }));

      supervisor.cancel(run.runId, 'manual-cancel');

      const exit: RunExit = await run.wait();
      assert.equal(exit.reason, 'manual-cancel');
    });
  });

  describe('cancelScope', () => {
    it('cancels all runs with matching scopeKey', async () => {
      const r1 = track(await supervisor.spawn({
        scopeKey: 'scope-x',
        argv: echoInput(['setTimeout(() => {}, 30000);']),
      }));
      const r2 = track(await supervisor.spawn({
        scopeKey: 'scope-x',
        argv: echoInput(['setTimeout(() => {}, 30000);']),
      }));
      const r3 = track(await supervisor.spawn({
        scopeKey: 'scope-y',
        argv: echoInput(['setTimeout(() => {}, 30000);']),
      }));

      supervisor.cancelScope('scope-x', 'manual-cancel');

      const [e1, e2] = await Promise.all([r1.wait(), r2.wait()]);
      assert.equal(e1.reason, 'manual-cancel');
      assert.equal(e2.reason, 'manual-cancel');

      // r3 should NOT be cancelled (different scope)
      // Manually cancel r3 to avoid hanging
      supervisor.cancel(r3.runId, 'manual-cancel');
      const e3 = await r3.wait();
      assert.equal(e3.reason, 'manual-cancel');
    });
  });

  describe('timeout', () => {
    it('kills process on overall timeout', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['setTimeout(() => {}, 30000);']),
        timeoutMs: 200,
      }));

      const exit: RunExit = await run.wait();
      assert.equal(exit.reason, 'overall-timeout');
      assert.equal(exit.timedOut, true);
    });

    it('kills process on no-output timeout', async () => {
      // Process that sleeps without producing output
      const run = track(await supervisor.spawn({
        argv: echoInput([
          'setTimeout(() => console.log("late"), 5000);',
        ]),
        noOutputTimeoutMs: 300,
      }));

      const exit: RunExit = await run.wait();
      assert.equal(exit.reason, 'no-output-timeout');
      assert.equal(exit.noOutputTimedOut, true);
    });

    it('resets no-output timer when output is produced', async () => {
      // Process that outputs regularly
      const run = track(await supervisor.spawn({
        argv: echoInput([
          'let i = 0;',
          'const t = setInterval(() => { console.log(i++); if (i >= 4) { clearInterval(t); } }, 50);',
        ]),
        noOutputTimeoutMs: 500,
      }));

      const exit: RunExit = await run.wait();
      // Should complete normally (output resets the timer each time)
      assert.equal(exit.reason, 'exit');
    });
  });

  describe('replaceExistingScope', () => {
    it('cancels existing scope runs before spawning new one', async () => {
      const oldRun = track(await supervisor.spawn({
        scopeKey: 'scope-z',
        argv: echoInput(['setTimeout(() => {}, 30000);']),
      }));

      const newRun = track(await supervisor.spawn({
        scopeKey: 'scope-z',
        replaceExistingScope: true,
        argv: echoInput(['console.log("replacement");']),
      }));

      const oldExit = await oldRun.wait();
      assert.equal(oldExit.reason, 'manual-cancel');

      const newExit = await newRun.wait();
      assert.equal(newExit.reason, 'exit');
      assert.ok(newExit.stdout.includes('replacement'));
    });
  });

  describe('captureOutput: false', () => {
    it('does not retain stdout in RunExit when captureOutput is false', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.log("secret");']),
        captureOutput: false,
      }));

      const exit: RunExit = await run.wait();
      assert.equal(exit.stdout, '');
    });

    it('still fires onStdout callback when captureOutput is false', async () => {
      let received = '';
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.log("seen");']),
        captureOutput: false,
        onStdout: (chunk) => { received += chunk; },
      }));

      await run.wait();
      assert.ok(received.includes('seen'));
    });
  });

  describe('stdin', () => {
    it('writes input to process stdin', async () => {
      // Node script that reads stdin and echoes it
      const run = track(await supervisor.spawn({
        argv: ['node', '-e', `
          let data = '';
          process.stdin.on('data', (chunk) => { data += chunk; });
          process.stdin.on('end', () => { console.log(data); });
        `],
        input: 'hello-stdin',
      }));

      const exit: RunExit = await run.wait();
      assert.ok(exit.stdout.includes('hello-stdin'));
    });
  });

  describe('getRecord after completion', () => {
    it('returns exited record after process finishes', async () => {
      const run = track(await supervisor.spawn({
        argv: echoInput(['console.log("done");']),
      }));

      await run.wait();

      const record = supervisor.getRecord(run.runId);
      assert.ok(record);
      assert.equal(record.state, 'exited');
      assert.equal(record.exitCode, 0);
    });
  });

  describe('registerLogicalRun', () => {
    it('returns a ManagedRun with a generated runId', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        abortController: abort,
      }));

      assert.ok(run.runId);
      assert.ok(run.startedAtMs > 0);
      assert.equal(run.pid, undefined); // logical runs have no PID
    });

    it('creates a run record in the registry (state=running)', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        abortController: abort,
      }));

      const record = supervisor.getRecord(run.runId);
      assert.ok(record);
      assert.equal(record.state, 'running');
      assert.equal(record.runId, run.runId);
    });

    it('honors explicit runId', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        runId: 'custom-logical-id',
        abortController: abort,
      }));

      assert.equal(run.runId, 'custom-logical-id');
    });

    it('cancel() aborts the AbortController', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        abortController: abort,
      }));

      let aborted = false;
      abort.signal.addEventListener('abort', () => { aborted = true; });

      run.cancel('manual-cancel');
      assert.equal(aborted, true);
      assert.equal(abort.signal.aborted, true);
    });

    it('cancel() updates record state to exiting', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        abortController: abort,
      }));

      run.cancel('scope-cleanup');
      const record = supervisor.getRecord(run.runId);
      assert.ok(record);
      assert.equal(record.state, 'exiting');
      assert.equal(record.terminationReason, 'scope-cleanup');
    });

    it('sets scopeKey on the run record', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        scopeKey: 'session-abc',
        abortController: abort,
      }));

      const record = supervisor.getRecord(run.runId);
      assert.equal(record!.scopeKey, 'session-abc');
    });
  });

  describe('finalizeLogicalRun', () => {
    it('moves record to exited state', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        abortController: abort,
      }));

      const finalized = supervisor.finalizeLogicalRun(run.runId, {
        reason: 'exit',
        exitCode: 0,
        exitSignal: null,
      });

      assert.ok(finalized);
      assert.equal(finalized.state, 'exited');
      assert.equal(finalized.exitCode, 0);
    });

    it('removes from active map (cancel no-ops after finalize)', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        abortController: abort,
      }));

      supervisor.finalizeLogicalRun(run.runId, {
        reason: 'exit',
        exitCode: 0,
        exitSignal: null,
      });

      // Calling cancel after finalize should be a no-op (run not in active map)
      // No error should be thrown
      supervisor.cancel(run.runId, 'manual-cancel');
    });

    it('returns undefined for unknown runId', () => {
      const result = supervisor.finalizeLogicalRun('nonexistent-id', {
        reason: 'exit',
        exitCode: 0,
        exitSignal: null,
      });

      assert.equal(result, undefined);
    });

    it('records non-zero exit code', () => {
      const abort = new AbortController();
      const run = track(supervisor.registerLogicalRun({
        abortController: abort,
      }));

      const finalized = supervisor.finalizeLogicalRun(run.runId, {
        reason: 'spawn-error',
        exitCode: 1,
        exitSignal: null,
      });

      assert.equal(finalized!.exitCode, 1);
      assert.equal(finalized!.terminationReason, 'spawn-error');
    });
  });

  describe('cancelScope with logical runs', () => {
    it('cancels logical runs in scope', () => {
      const abort1 = new AbortController();
      const abort2 = new AbortController();

      const r1 = track(supervisor.registerLogicalRun({
        scopeKey: 'logical-scope',
        abortController: abort1,
      }));
      track(supervisor.registerLogicalRun({
        scopeKey: 'logical-scope',
        abortController: abort2,
      }));

      supervisor.cancelScope('logical-scope', 'scope-cleanup');

      assert.equal(abort1.signal.aborted, true);
      assert.equal(abort2.signal.aborted, true);
    });

    it('replaceExistingScope cancels old logical run before registering new one', () => {
      const abort1 = new AbortController();
      track(supervisor.registerLogicalRun({
        scopeKey: 'replace-logical-scope',
        abortController: abort1,
      }));

      const abort2 = new AbortController();
      supervisor.registerLogicalRun({
        scopeKey: 'replace-logical-scope',
        replaceExistingScope: true,
        abortController: abort2,
      });

      // Old AbortController should be aborted
      assert.equal(abort1.signal.aborted, true);
      // New one should be untouched
      assert.equal(abort2.signal.aborted, false);
    });
  });
});
