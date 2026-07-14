// ── Task Controller Unit Test ──
// CTO-007 Phase 1: Validates TaskController CRUD + state machine + backward compat.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { TaskController, type Task, type TaskStatus, type TaskPriority } from '../src/task-controller/controller.js';

// ── Shared setup ──

function freshController(): TaskController {
  const c = new TaskController();
  c.reset();
  return c;
}

// ── createTask ──

describe('TaskController.createTask', () => {
  let ctrl: TaskController;
  beforeEach(() => { ctrl = freshController(); });

  it('creates a task with default priority (normal)', () => {
    const task = ctrl.createTask('hello world');
    assert.ok(task.taskId.startsWith('task_'));
    assert.strictEqual(task.description, 'hello world');
    assert.strictEqual(task.status, 'queued');
    assert.strictEqual(task.priority, 'normal');
    assert.strictEqual(task.controller, 'trimc-main');
    assert.ok(task.createdAt === task.updatedAt);
    // ISO 8601 timestamp
    assert.ok(Date.parse(task.createdAt) > 0);
  });

  it('creates a task with custom priority', () => {
    const task = ctrl.createTask('urgent fix', 'critical');
    assert.strictEqual(task.priority, 'critical');
  });

  it('trims description whitespace', () => {
    const task = ctrl.createTask('  padded  ');
    assert.strictEqual(task.description, 'padded');
  });

  it('throws on empty description', () => {
    assert.throws(() => ctrl.createTask(''), /description must not be empty/);
    assert.throws(() => ctrl.createTask('   '), /description must not be empty/);
  });

  it('generates monotonically increasing task IDs', () => {
    const t1 = ctrl.createTask('a');
    const t2 = ctrl.createTask('b');
    const t3 = ctrl.createTask('c');
    assert.strictEqual(t1.taskId, 'task_1');
    assert.strictEqual(t2.taskId, 'task_2');
    assert.strictEqual(t3.taskId, 'task_3');
  });

  it('returns a copy, not the internal reference', () => {
    const task = ctrl.createTask('ref test');
    task.description = 'mutated';
    const fetched = ctrl.getTask(task.taskId)!;
    assert.strictEqual(fetched.description, 'ref test');
  });
});

// ── getTask ──

describe('TaskController.getTask', () => {
  let ctrl: TaskController;
  beforeEach(() => { ctrl = freshController(); });

  it('returns the task by ID', () => {
    const created = ctrl.createTask('fetch me');
    const fetched = ctrl.getTask(created.taskId);
    assert.ok(fetched);
    assert.strictEqual(fetched.taskId, created.taskId);
    assert.strictEqual(fetched.description, 'fetch me');
  });

  it('returns undefined for non-existent ID', () => {
    assert.strictEqual(ctrl.getTask('task_999'), undefined);
  });

  it('returns a copy, not live reference', () => {
    const t = ctrl.createTask('orig');
    const copy = ctrl.getTask(t.taskId)!;
    copy.description = 'hacked';
    const again = ctrl.getTask(t.taskId)!;
    assert.strictEqual(again.description, 'orig');
  });
});

// ── listTasks ──

describe('TaskController.listTasks', () => {
  let ctrl: TaskController;
  beforeEach(() => {
    ctrl = freshController();
    ctrl.createTask('normal task a');
    ctrl.createTask('urgent task', 'high');
    ctrl.createTask('critical task', 'critical');
    ctrl.createTask('normal task b');
  });

  it('lists all tasks unfiltered', () => {
    const all = ctrl.listTasks();
    assert.strictEqual(all.length, 4);
  });

  it('filters by status', () => {
    // Mark two tasks as running
    const tasks = ctrl.listTasks();
    ctrl.updateTaskStatus(tasks[0].taskId, 'running');
    ctrl.updateTaskStatus(tasks[1].taskId, 'running');
    // Queue a new one — it will be task_5
    const running = ctrl.listTasks({ status: 'running' });
    assert.strictEqual(running.length, 2);
    running.forEach(t => assert.strictEqual(t.status, 'running'));
  });

  it('filters by priority', () => {
    const highPlus = ctrl.listTasks({ priority: 'high' });
    assert.strictEqual(highPlus.length, 1);
    assert.strictEqual(highPlus[0].priority, 'high');
  });

  it('filters by both status and priority', () => {
    const tasks = ctrl.listTasks();
    // Move the high-priority task to running
    const highTask = tasks.find(t => t.priority === 'high')!;
    ctrl.updateTaskStatus(highTask.taskId, 'running');
    const result = ctrl.listTasks({ status: 'running', priority: 'high' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].taskId, highTask.taskId);
  });

  it('returns empty array when no match', () => {
    const result = ctrl.listTasks({ status: 'cancelled' });
    assert.strictEqual(result.length, 0);
  });

  it('returns copies, not live references', () => {
    const all = ctrl.listTasks();
    all[0].description = 'mutated';
    const again = ctrl.listTasks();
    assert.notStrictEqual(again[0].description, 'mutated');
  });
});

// ── updateTaskStatus — valid transitions ──

describe('TaskController.updateTaskStatus — valid', () => {
  let ctrl: TaskController;
  beforeEach(() => { ctrl = freshController(); });

  it('queued → running', () => {
    const t = ctrl.createTask('start me');
    const updated = ctrl.updateTaskStatus(t.taskId, 'running');
    assert.strictEqual(updated.status, 'running');
    assert.ok(new Date(updated.updatedAt) >= new Date(t.updatedAt));
  });

  it('running → completed', () => {
    const t = ctrl.createTask('finish me');
    ctrl.updateTaskStatus(t.taskId, 'running');
    const done = ctrl.updateTaskStatus(t.taskId, 'completed');
    assert.strictEqual(done.status, 'completed');
  });

  it('running → failed', () => {
    const t = ctrl.createTask('fail me');
    ctrl.updateTaskStatus(t.taskId, 'running');
    const failed = ctrl.updateTaskStatus(t.taskId, 'failed');
    assert.strictEqual(failed.status, 'failed');
  });

  it('queued → cancelled (direct cancel)', () => {
    const t = ctrl.createTask('cancel before start');
    const cancelled = ctrl.updateTaskStatus(t.taskId, 'cancelled');
    assert.strictEqual(cancelled.status, 'cancelled');
  });

  it('running → cancelled (cancel mid-flight)', () => {
    const t = ctrl.createTask('cancel mid');
    ctrl.updateTaskStatus(t.taskId, 'running');
    const cancelled = ctrl.updateTaskStatus(t.taskId, 'cancelled');
    assert.strictEqual(cancelled.status, 'cancelled');
  });
});

// ── updateTaskStatus — invalid / terminal ──

describe('TaskController.updateTaskStatus — invalid', () => {
  let ctrl: TaskController;
  beforeEach(() => { ctrl = freshController(); });

  it('throws on non-existent taskId', () => {
    assert.throws(() => ctrl.updateTaskStatus('task_999', 'running'), /Task not found/);
  });

  it('throws on invalid transition: queued → completed', () => {
    const t = ctrl.createTask('skip running');
    assert.throws(() => ctrl.updateTaskStatus(t.taskId, 'completed'), /Invalid transition/);
  });

  it('throws on invalid transition: queued → failed', () => {
    const t = ctrl.createTask('fail directly');
    assert.throws(() => ctrl.updateTaskStatus(t.taskId, 'failed'), /Invalid transition/);
  });

  it('throws on terminal: completed is irreversible', () => {
    const t = ctrl.createTask('done');
    ctrl.updateTaskStatus(t.taskId, 'running');
    ctrl.updateTaskStatus(t.taskId, 'completed');
    assert.throws(
      () => ctrl.updateTaskStatus(t.taskId, 'running'),
      /Cannot transition from terminal status/
    );
  });

  it('throws on terminal: failed is irreversible', () => {
    const t = ctrl.createTask('dead');
    ctrl.updateTaskStatus(t.taskId, 'running');
    ctrl.updateTaskStatus(t.taskId, 'failed');
    assert.throws(
      () => ctrl.updateTaskStatus(t.taskId, 'running'),
      /Cannot transition from terminal status/
    );
    // Also can't go to completed, queued, or cancelled
    assert.throws(() => ctrl.updateTaskStatus(t.taskId, 'completed'), /terminal/);
    assert.throws(() => ctrl.updateTaskStatus(t.taskId, 'queued'), /terminal/);
    assert.throws(() => ctrl.updateTaskStatus(t.taskId, 'cancelled'), /terminal/);
  });

  it('throws on terminal: cancelled is irreversible', () => {
    const t = ctrl.createTask('aborted');
    ctrl.updateTaskStatus(t.taskId, 'cancelled');
    assert.throws(() => ctrl.updateTaskStatus(t.taskId, 'running'), /terminal/);
    assert.throws(() => ctrl.updateTaskStatus(t.taskId, 'queued'), /terminal/);
  });
});

// ── Backward compatibility: acceptPlaceholder ──

describe('TaskController.acceptPlaceholder (backward compat)', () => {
  let ctrl: TaskController;
  beforeEach(() => { ctrl = freshController(); });

  it('returns the legacy AcceptedTaskPlaceholder shape', () => {
    const ph = ctrl.acceptPlaceholder();
    assert.ok(ph.taskId.startsWith('task_'));
    assert.strictEqual(ph.controller, 'trimc-main');
    assert.strictEqual(ph.status, 'accepted');
    assert.strictEqual(ph.queueStatus, 'queued');
  });

  it('internally creates a Task that is retrievable', () => {
    const ph = ctrl.acceptPlaceholder();
    const task = ctrl.getTask(ph.taskId);
    assert.ok(task);
    assert.strictEqual(task.status, 'queued');
    assert.strictEqual(task.description, 'placeholder');
  });

  it('acceptPlaceholder contributes to taskCount', () => {
    assert.strictEqual(ctrl.taskCount, 0);
    ctrl.acceptPlaceholder();
    assert.strictEqual(ctrl.taskCount, 1);
    ctrl.createTask('extra');
    assert.strictEqual(ctrl.taskCount, 2);
  });
});

// ── Reset & taskCount ──

describe('TaskController.reset & taskCount', () => {
  it('resets all state', () => {
    const ctrl = freshController();
    ctrl.createTask('a');
    ctrl.createTask('b');
    assert.strictEqual(ctrl.taskCount, 2);
    ctrl.reset();
    assert.strictEqual(ctrl.taskCount, 0);
    // ID counter resets too
    const t = ctrl.createTask('after reset');
    assert.strictEqual(t.taskId, 'task_1');
  });
});
