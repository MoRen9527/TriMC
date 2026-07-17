import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunRegistry } from '../registry.js';
import type { RunRecord, RunState, TerminationReason } from '../types.js';

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const ts = Date.now();
  return {
    runId: 'run-001',
    scopeKey: 'test-scope',
    pid: 12345,
    startedAtMs: ts,
    lastOutputAtMs: ts,
    createdAtMs: ts,
    updatedAtMs: ts,
    state: 'running',
    ...overrides,
  };
}

describe('RunRegistry', () => {
  describe('add and get', () => {
    it('adds a record and retrieves it by runId', () => {
      const reg = createRunRegistry();
      const record = makeRecord();
      reg.add(record);

      const got = reg.get('run-001');
      assert.ok(got);
      assert.equal(got.runId, 'run-001');
      assert.equal(got.state, 'running');
    });

    it('returns undefined for unknown runId', () => {
      const reg = createRunRegistry();
      assert.equal(reg.get('nonexistent'), undefined);
    });

    it('returns a shallow copy (not the original reference)', () => {
      const reg = createRunRegistry();
      const record = makeRecord();
      reg.add(record);
      const got = reg.get('run-001')!;
      assert.notEqual(got, record);
    });
  });

  describe('list', () => {
    it('returns empty array when no records', () => {
      const reg = createRunRegistry();
      assert.deepEqual(reg.list(), []);
    });

    it('lists all records', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1' }));
      reg.add(makeRecord({ runId: 'r2' }));
      const list = reg.list();
      assert.equal(list.length, 2);
    });
  });

  describe('listByScope', () => {
    it('returns records matching scopeKey', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1', scopeKey: 'scope-a' }));
      reg.add(makeRecord({ runId: 'r2', scopeKey: 'scope-b' }));
      reg.add(makeRecord({ runId: 'r3', scopeKey: 'scope-a' }));

      const inA = reg.listByScope('scope-a');
      assert.equal(inA.length, 2);
      assert.ok(inA.every((r) => r.scopeKey === 'scope-a'));
    });

    it('returns empty for empty scopeKey', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1', scopeKey: 'scope-a' }));
      assert.deepEqual(reg.listByScope(''), []);
      assert.deepEqual(reg.listByScope('  '), []);
    });
  });

  describe('updateState', () => {
    it('updates state and timestamps', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1', state: 'running' }));
      const prev = reg.get('r1')!;

      const updated = reg.updateState('r1', 'exiting');
      assert.ok(updated);
      assert.equal(updated.state, 'exiting');
      assert.ok(updated.updatedAtMs >= prev.updatedAtMs);
    });

    it('applies optional pid patch', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1', pid: undefined }));
      const updated = reg.updateState('r1', 'running', { pid: 99999 });
      assert.equal(updated?.pid, 99999);
    });

    it('returns undefined for unknown runId', () => {
      const reg = createRunRegistry();
      assert.equal(reg.updateState('nope', 'exiting'), undefined);
    });
  });

  describe('touchOutput', () => {
    it('updates lastOutputAtMs', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1' }));
      const before = reg.get('r1')!;

      reg.touchOutput('r1');
      const after = reg.get('r1')!;
      assert.ok(after.lastOutputAtMs >= before.lastOutputAtMs);
    });

    it('is a no-op for unknown runId', () => {
      const reg = createRunRegistry();
      reg.touchOutput('nope'); // should not throw
    });
  });

  describe('finalize', () => {
    it('sets state to exited and records exit info', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1', state: 'running' }));

      const result = reg.finalize('r1', { reason: 'exit', exitCode: 0, exitSignal: null });
      assert.ok(result);
      assert.equal(result.firstFinalize, true);
      assert.equal(result.record.state, 'exited');
      assert.equal(result.record.exitCode, 0);
      assert.equal(result.record.terminationReason, 'exit');
    });

    it('firstFinalize is false on second finalize', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1', state: 'exiting' }));
      reg.finalize('r1', { reason: 'exit', exitCode: 0, exitSignal: null });
      const second = reg.finalize('r1', { reason: 'exit', exitCode: 1, exitSignal: null });
      assert.equal(second?.firstFinalize, false);
    });

    it('preserves original exitCode on re-finalize', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1' }));
      reg.finalize('r1', { reason: 'exit', exitCode: 0, exitSignal: null });
      const second = reg.finalize('r1', { reason: 'exit', exitCode: 99, exitSignal: null });
      assert.equal(second?.record.exitCode, 0); // original preserved
    });

    it('returns null for unknown runId', () => {
      const reg = createRunRegistry();
      assert.equal(reg.finalize('nope', { reason: 'exit', exitCode: 0, exitSignal: null }), null);
    });
  });

  describe('delete', () => {
    it('removes a record', () => {
      const reg = createRunRegistry();
      reg.add(makeRecord({ runId: 'r1' }));
      reg.delete('r1');
      assert.equal(reg.get('r1'), undefined);
    });
  });

  describe('pruning', () => {
    it('prunes old exited records beyond maxExitedRecords', () => {
      const reg = createRunRegistry({ maxExitedRecords: 2 });
      for (let i = 0; i < 5; i++) {
        reg.add(makeRecord({ runId: `r${i}`, state: 'exited' }));
      }
      // Adding one more exited record should trigger pruning
      reg.add(makeRecord({ runId: 'r5', state: 'exited' }));
      reg.finalize('r5', { reason: 'exit', exitCode: 0, exitSignal: null });

      const list = reg.list();
      // Should have maxExitedRecords (2) + any non-exited records
      assert.ok(list.length <= 3); // allowance for timing
    });
  });
});
