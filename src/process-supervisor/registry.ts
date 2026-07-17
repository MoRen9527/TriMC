import type { RunRecord, RunRegistry, RunState, TerminationReason } from './types.js';

function nowMs(): number {
  return Date.now();
}

const DEFAULT_MAX_EXITED_RECORDS = 2_000;

function resolveMaxExitedRecords(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_EXITED_RECORDS;
  }
  return Math.max(1, Math.floor(value));
}

export function createRunRegistry(options?: { maxExitedRecords?: number }): RunRegistry {
  const records = new Map<string, RunRecord>();
  const maxExitedRecords = resolveMaxExitedRecords(options?.maxExitedRecords);

  const pruneExitedRecords = () => {
    let exited = 0;
    for (const record of records.values()) {
      if (record.state === 'exited') exited += 1;
    }
    if (exited <= maxExitedRecords) return;

    let remove = exited - maxExitedRecords;
    for (const [runId, record] of records.entries()) {
      if (remove <= 0) break;
      if (record.state !== 'exited') continue;
      records.delete(runId);
      remove -= 1;
    }
  };

  const add: RunRegistry['add'] = (record) => {
    records.set(record.runId, { ...record });
  };

  const get: RunRegistry['get'] = (runId) => {
    const record = records.get(runId);
    return record ? { ...record } : undefined;
  };

  const list: RunRegistry['list'] = () => {
    return Array.from(records.values()).map((r) => ({ ...r }));
  };

  const listByScope: RunRegistry['listByScope'] = (scopeKey) => {
    if (!scopeKey.trim()) return [];
    return Array.from(records.values())
      .filter((r) => r.scopeKey === scopeKey)
      .map((r) => ({ ...r }));
  };

  const updateState: RunRegistry['updateState'] = (runId, state, patch) => {
    const current = records.get(runId);
    if (!current) return undefined;
    const next: RunRecord = {
      ...current,
      ...patch,
      state,
      updatedAtMs: nowMs(),
      lastOutputAtMs: current.lastOutputAtMs,
    };
    records.set(runId, next);
    return { ...next };
  };

  const touchOutput: RunRegistry['touchOutput'] = (runId) => {
    const current = records.get(runId);
    if (!current) return;
    const ts = nowMs();
    records.set(runId, { ...current, lastOutputAtMs: ts, updatedAtMs: ts });
  };

  const finalize: RunRegistry['finalize'] = (runId, exit) => {
    const current = records.get(runId);
    if (!current) return null;
    const firstFinalize = current.state !== 'exited';
    const next: RunRecord = {
      ...current,
      state: 'exited',
      terminationReason: current.terminationReason ?? exit.reason,
      exitCode: current.exitCode !== undefined ? current.exitCode : exit.exitCode,
      exitSignal: current.exitSignal !== undefined ? current.exitSignal : exit.exitSignal,
      updatedAtMs: nowMs(),
    };
    records.set(runId, next);
    pruneExitedRecords();
    return { record: { ...next }, firstFinalize };
  };

  const del: RunRegistry['delete'] = (runId) => {
    records.delete(runId);
  };

  return { add, get, list, listByScope, updateState, touchOutput, finalize, delete: del };
}
