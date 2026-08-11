import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { createRunRegistry } from './registry.js';
import type {
  LogicalRunFinalizeInput,
  ManagedRun,
  ManagedRunStdin,
  ProcessSupervisor,
  RegisterLogicalRunInput,
  RunExit,
  RunRecord,
  SpawnInput,
  TerminationReason,
} from './types.js';

type ActiveRun = {
  managedRun: ManagedRun;
  scopeKey?: string;
};

function clampTimeout(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.floor(value));
}

function isTimeoutReason(reason: TerminationReason): boolean {
  return reason === 'overall-timeout' || reason === 'no-output-timeout';
}

function buildStdin(child: ChildProcess): ManagedRunStdin | undefined {
  if (!child.stdin) return undefined;
  return {
    write: (data: string, cb?: (err?: Error | null) => void) => {
      child.stdin!.write(data, cb as (err?: Error | null | undefined) => void);
    },
    end: () => child.stdin!.end(),
  };
}

export function createProcessSupervisor(): ProcessSupervisor {
  const registry = createRunRegistry();
  const active = new Map<string, ActiveRun>();

  const cancel = (runId: string, reason: TerminationReason = 'manual-cancel') => {
    const entry = active.get(runId);
    if (!entry) return;
    registry.updateState(runId, 'exiting', { terminationReason: reason });
    entry.managedRun.cancel(reason);
  };

  const cancelScope = (scopeKey: string, reason: TerminationReason = 'manual-cancel') => {
    if (!scopeKey.trim()) return;
    for (const [runId, entry] of active.entries()) {
      if (entry.scopeKey === scopeKey) cancel(runId, reason);
    }
  };

  const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
    const runId = input.runId?.trim() || crypto.randomUUID();

    if (input.replaceExistingScope && input.scopeKey?.trim()) {
      cancelScope(input.scopeKey, 'manual-cancel');
    }

    if (input.argv.length === 0) {
      throw new Error('spawn argv cannot be empty');
    }

    const startedAtMs = Date.now();
    const record: RunRecord = {
      runId,
      scopeKey: input.scopeKey?.trim() || undefined,
      state: 'starting',
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    let forcedReason: TerminationReason | null = null;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeoutTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const captureOutput = input.captureOutput !== false;
    const overallTimeoutMs = clampTimeout(input.timeoutMs);
    const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);

    const setForcedReason = (reason: TerminationReason) => {
      if (forcedReason) return;
      forcedReason = reason;
      registry.updateState(runId, 'exiting', { terminationReason: reason });
    };

    const clearTimers = () => {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (noOutputTimer) { clearTimeout(noOutputTimer); noOutputTimer = null; }
    };

    const touchOutput = () => {
      registry.touchOutput(runId);
      if (!noOutputTimeoutMs || settled) return;
      if (noOutputTimer) clearTimeout(noOutputTimer);
      noOutputTimer = setTimeout(() => requestCancel('no-output-timeout'), noOutputTimeoutMs);
    };

    const requestCancel = (reason: TerminationReason) => {
      setForcedReason(reason);
      if (!settled) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    };

    const [command, ...args] = input.argv;
    if (!command) throw new Error('process-supervisor: spawn requires non-empty argv');
    const child: ChildProcess = cpSpawn(command, args, {
      cwd: input.cwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    registry.updateState(runId, 'running', { pid: child.pid ?? undefined });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (captureOutput) stdout += text;
      input.onStdout?.(text);
      touchOutput();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (captureOutput) stderr += text;
      input.onStderr?.(text);
      touchOutput();
    });

    if (input.input && child.stdin) {
      child.stdin.write(input.input);
      child.stdin.end();
    } else if (child.stdin) {
      // No input provided: close stdin immediately so commands that read from
      // stdin (Windows find.exe, grep without args, sort, etc.) don't block
      // forever waiting for input — which manifests as the shell "hanging".
      child.stdin.end();
    }

    if (overallTimeoutMs) {
      timeoutTimer = setTimeout(() => requestCancel('overall-timeout'), overallTimeoutMs);
    }
    if (noOutputTimeoutMs) {
      noOutputTimer = setTimeout(() => requestCancel('no-output-timeout'), noOutputTimeoutMs);
    }

    const waitPromise = new Promise<RunExit>((resolve, reject) => {
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimers();
        active.delete(runId);
        registry.finalize(runId, { reason: 'spawn-error', exitCode: null, exitSignal: null });
        reject(err);
      });

      child.on('close', (code, signal) => {
        if (settled) {
          resolve({
            reason: forcedReason ?? 'exit',
            exitCode: code,
            exitSignal: signal,
            durationMs: Date.now() - startedAtMs,
            stdout,
            stderr,
            timedOut: isTimeoutReason(forcedReason ?? 'exit'),
            noOutputTimedOut: forcedReason === 'no-output-timeout',
          });
          return;
        }
        settled = true;
        clearTimers();
        active.delete(runId);

        const reason: TerminationReason =
          forcedReason ?? (signal != null ? 'signal' : 'exit');
        const exit: RunExit = {
          reason,
          exitCode: code,
          exitSignal: signal,
          durationMs: Date.now() - startedAtMs,
          stdout,
          stderr,
          timedOut: isTimeoutReason(forcedReason ?? reason),
          noOutputTimedOut: forcedReason === 'no-output-timeout',
        };
        registry.finalize(runId, {
          reason: exit.reason,
          exitCode: exit.exitCode,
          exitSignal: exit.exitSignal,
        });
        resolve(exit);
      });
    });

    const managedRun: ManagedRun = {
      runId,
      pid: child.pid ?? undefined,
      startedAtMs,
      stdin: buildStdin(child),
      wait: () => waitPromise,
      cancel: (reason = 'manual-cancel') => requestCancel(reason),
    };

    active.set(runId, { managedRun, scopeKey: input.scopeKey?.trim() || undefined });
    return managedRun;
  };

  const getRecord = (runId: string) => registry.get(runId);

  const registerLogicalRun = (input: RegisterLogicalRunInput): ManagedRun => {
    const runId = input.runId?.trim() || crypto.randomUUID();

    if (input.replaceExistingScope && input.scopeKey?.trim()) {
      cancelScope(input.scopeKey, 'manual-cancel');
    }

    const startedAtMs = Date.now();
    const record: RunRecord = {
      runId,
      scopeKey: input.scopeKey?.trim() || undefined,
      state: 'running',
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    const managedRun: ManagedRun = {
      runId,
      startedAtMs,
      wait: () => {
        // Logical runs are managed in-process; wait is provided for interface
        // compatibility but callers should use spawnAgent events, not ManagedRun.wait().
        return new Promise<RunExit>(() => {
          // Never resolves — caller finalizes via finalizeLogicalRun
        });
      },
      cancel: (reason = 'manual-cancel') => {
        registry.updateState(runId, 'exiting', { terminationReason: reason });
        input.abortController.abort(reason);
      },
    };

    active.set(runId, { managedRun, scopeKey: input.scopeKey?.trim() || undefined });
    return managedRun;
  };

  const finalizeLogicalRun = (runId: string, exit: LogicalRunFinalizeInput): RunRecord | undefined => {
    active.delete(runId);
    const result = registry.finalize(runId, {
      reason: exit.reason,
      exitCode: exit.exitCode,
      exitSignal: exit.exitSignal,
    });
    return result?.record;
  };

  return {
    spawn,
    registerLogicalRun,
    finalizeLogicalRun,
    cancel,
    cancelScope,
    getRecord,
  };
}
