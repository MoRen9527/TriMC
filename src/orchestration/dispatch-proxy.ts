// ── Dispatch Proxy ──
// 6-step dispatch pipeline: classify → estimate → route → budget → schedule → dispatch
// Source: TriMC/docs/engineering/employee-orchestration-design.md §3.5

import { loadEmployeeRegistry } from './employee-registry.js';
import { route } from './capability-router.js';
import { transition, assign, escalate } from './employee-scheduler.js';
import { estimateCost, checkBudget } from './cost-controller.js';
import type {
  EmployeeRecord,
  TaskRecord,
  TaskPriority,
  DispatchRequest,
  DispatchResult,
  DispatchTraceEntry,
} from './types.js';

// ── Step 1: Classify ──

function classifyTask(request: DispatchRequest): { type: string; expectedOutputs: string[]; decisionType?: string; priority: TaskPriority } {
  return {
    type: request.task.type,
    expectedOutputs: request.task.expectedOutputs,
    decisionType: request.task.decisionType,
    priority: request.task.priority,
  };
}

// ── Step 2: Estimate (delegated to cost-controller) ──

// ── Step 3: Route (delegated to capability-router) ──

// ── Step 4: Check Budget (delegated to cost-controller) ──

// ── Step 5: Schedule (create task record, transition) ──

function createTaskRecord(request: DispatchRequest, taskId: string): TaskRecord {
  return {
    taskId,
    type: request.task.type,
    priority: request.task.priority,
    description: request.task.description,
    expectedOutputs: request.task.expectedOutputs,
    decisionType: request.task.decisionType,
    state: 'queued',
    requester: request.requester,
    parentTaskId: request.context?.parentTaskId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retryCount: 0,
  };
}

// ── Step 6: Dispatch (assign → running) ──

// ── Trace Helpers ──

let _taskCounter = 0;
function nextTaskId(): string {
  _taskCounter++;
  return `task-${Date.now()}-${_taskCounter}`;
}

function trace(step: string, success: boolean, message: string): DispatchTraceEntry {
  return { step, success, message, timestamp: new Date().toISOString() };
}

// ── Public API ──

export interface DispatchDeps {
  registryDir: string;               // path to TriCompany/docs/registry/
  employees?: EmployeeRecord[];      // pre-loaded employees (for testing)
}

// ── Executor Interface (M1 Phase-2) ──
// Step 6 的真实执行器：把已调度的任务交给外部会话（如 session-bridge.sendMessage）。
// dispatch() 保持同步纯函数（兼容既有调用方/测试）；dispatchAsync() 在 Step 6 后
// 调用 executor 并回写执行结果。
export interface DispatchExecutorContext {
  taskId: string;
  employeeId: string;
  cwd: string;
}

export interface DispatchExecutor {
  execute(task: DispatchRequest['task'], ctx: DispatchExecutorContext): Promise<{
    ok: boolean;
    output?: string;
    error?: string;
  }>;
}

export interface AsyncDispatchDeps extends DispatchDeps {
  executor?: DispatchExecutor;
  cwd?: string;
}

/**
 * 6-step dispatch pipeline:
 * 1. Classify task
 * 2. Estimate cost
 * 3. Route to employee
 * 4. Budget gate
 * 5. Schedule (create task record, transition queued→assigned→running)
 * 6. Dispatch (return result)
 *
 * Phase A: all steps synchronous, single process.
 */
export function dispatch(
  request: DispatchRequest,
  deps: DispatchDeps,
): DispatchResult {
  const traces: DispatchTraceEntry[] = [];

  // Step 1: Classify
  const classified = classifyTask(request);
  traces.push(trace('classify', true, `Task classified as type="${classified.type}" priority="${classified.priority}"`));

  // Load employees
  const employees = deps.employees ?? loadEmployeeRegistry(deps.registryDir).employees;
  if (employees.length === 0) {
    traces.push(trace('load', false, 'No employees loaded from registry'));
    return { success: false, rejectionReason: 'No employees available', trace: traces };
  }
  traces.push(trace('load', true, `Loaded ${employees.length} employees`));

  // Step 2: Estimate
  // Use the first employee matching the task type for initial estimate; adjust after routing.
  const bestGuessEmployee = employees.find((e) => e.status.state === 'active') ?? employees[0];
  const costEstimate = estimateCost(bestGuessEmployee, classified.expectedOutputs);
  traces.push(trace('estimate', true, `Estimated ${costEstimate.estimatedTokens} tokens, $${costEstimate.estimatedCostUSD} (${costEstimate.modelTier})`));

  // Step 3: Route
  const decision = route(employees, {
    type: classified.type,
    expectedOutputs: classified.expectedOutputs,
    decisionType: classified.decisionType,
  });

  if (!decision.matched || !decision.primary) {
    traces.push(trace('route', false, `No match. IO:${decision.matchDetails.ioCoverage}% Auth:${decision.matchDetails.authorityMatch} Load:${decision.matchDetails.loadAvailable}`));

    // Try escalation
    if (decision.escalationPath.length > 0) {
      const escalationTarget = decision.escalationPath[0];
      traces.push(trace('escalate', true, `Escalating to ${escalationTarget.employeeId}`));
      return {
        success: true,
        escalationTo: escalationTarget.employeeId,
        trace: traces,
      };
    }

    return { success: false, rejectionReason: 'No matching employee found', trace: traces };
  }

  const primary = decision.primary;
  traces.push(trace('route', true, `Matched ${primary.employeeId} score=${decision.score} IO:${decision.matchDetails.ioCoverage}%`));

  // Step 4: Budget gate
  const budgetCheck = checkBudget(primary, costEstimate.estimatedTokens, costEstimate.estimatedCostUSD);
  if (!budgetCheck.approved) {
    traces.push(trace('budget', false, budgetCheck.reason ?? 'Budget exceeded'));

    // Try escalation
    if (decision.escalationPath.length > 0) {
      const escalationTarget = decision.escalationPath[0];
      traces.push(trace('escalate', true, `Escalating to ${escalationTarget.employeeId}`));
      return {
        success: true,
        escalationTo: escalationTarget.employeeId,
        trace: traces,
      };
    }

    return { success: false, rejectionReason: budgetCheck.reason, trace: traces };
  }
  traces.push(trace('budget', true, 'Budget approved'));

  // Step 5: Schedule
  const taskId = nextTaskId();
  let taskRecord = createTaskRecord(request, taskId);

  const assignResult = assign(taskRecord, primary, []);
  if (!assignResult.success) {
    traces.push(trace('schedule', false, assignResult.error ?? 'Schedule failed'));

    // Try alternatives
    for (const alt of decision.alternatives) {
      const altAssign = assign(taskRecord, alt, []);
      if (altAssign.success) {
        taskRecord = altAssign.task;
        traces.push(trace('schedule', true, `Scheduled via alternative ${alt.employeeId}`));
        break;
      }
    }

    if (taskRecord.state !== 'assigned') {
      return { success: false, rejectionReason: 'All scheduling options exhausted', trace: traces };
    }
  } else {
    taskRecord = assignResult.task;
    traces.push(trace('schedule', true, `Task ${taskId} assigned to ${primary.employeeId}`));
  }

  const runningResult = transition(taskRecord, 'running');
  if (!runningResult.success) {
    traces.push(trace('schedule', false, runningResult.error ?? 'Transition failed'));
    return { success: false, rejectionReason: runningResult.error, trace: traces };
  }
  taskRecord = runningResult.task;

  // Step 6: Dispatch
  traces.push(trace('dispatch', true, `Task ${taskId} dispatched to ${taskRecord.assignedTo}`));

  return {
    success: true,
    assignedTo: taskRecord.assignedTo,
    costEstimate: {
      estimatedTokens: costEstimate.estimatedTokens,
      estimatedCostUSD: costEstimate.estimatedCostUSD,
      modelTier: costEstimate.modelTier,
    },
    trace: traces,
  };
}

/**
 * 异步版：Step 6 之后调用 executor 真正执行任务，并回写执行结果。
 * dispatch() 的 6 步管道不变；executor 缺省时行为与 dispatch() 一致。
 */
export async function dispatchAsync(
  request: DispatchRequest,
  deps: AsyncDispatchDeps,
): Promise<DispatchResult & { output?: string; executionError?: string }> {
  const result = dispatch(request, deps);
  if (!result.success || !deps.executor) {
    return result;
  }
  const taskId = result.trace.find((t) => t.step === 'dispatch')?.message.match(/task-[0-9]+-[0-9]+/)?.[0];
  const assignedTo = result.assignedTo ?? '';
  const exec = await deps.executor.execute(request.task, {
    taskId: taskId ?? `task-${Date.now()}`,
    employeeId: assignedTo,
    cwd: deps.cwd ?? process.cwd(),
  });
  if (exec.ok) {
    return { ...result, output: exec.output };
  }
  return { ...result, success: false, rejectionReason: exec.error, executionError: exec.error };
}

// ── 2.1/2.2: TriLC HTTP Dispatch Executor ──

/**
 * TriLCDispatchExecutor implements DispatchExecutor by POSTing tasks to
 * TriLC's /internal/v1/tasks/submit endpoint and consuming the SSE stream.
 * Used by TriMC's dispatchAsync() to execute tasks on a remote TriLC node.
 */
export class TriLCDispatchExecutor implements DispatchExecutor {
  private trilcBaseUrl: string;
  private taskResultCallback?: (taskId: string, status: 'success' | 'failed', output?: string, error?: string) => void;

  constructor(trilcBaseUrl: string, taskResultCallback?: TriLCDispatchExecutor['taskResultCallback']) {
    this.trilcBaseUrl = trilcBaseUrl.replace(/\/$/, '');
    this.taskResultCallback = taskResultCallback;
  }

  async execute(
    task: { type: string; description: string; priority: string; expectedOutputs: string[]; decisionType?: string },
    ctx: { taskId: string; employeeId: string; cwd: string },
  ): Promise<{ ok: boolean; output?: string; error?: string }> {
    const submitUrl = `${this.trilcBaseUrl}/internal/v1/tasks/submit`;

    try {
      // Step 1: Submit task to TriLC
      const submitRes = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: task.description,
          conversationId: ctx.taskId,
          context: { workspaceRoot: ctx.cwd },
        }),
      });

      if (!submitRes.ok) {
        return { ok: false, error: `TriLC submit returned ${submitRes.status}` };
      }

      const { sessionId, streamEndpoint } = await submitRes.json() as {
        sessionId: string; streamEndpoint: string; status: string;
      };

      if (!streamEndpoint) {
        return { ok: false, error: 'TriLC did not return stream endpoint' };
      }

      // Step 2: Consume SSE stream
      const sseUrl = `${this.trilcBaseUrl}${streamEndpoint}`;
      const sseRes = await fetch(sseUrl, {
        headers: { accept: 'text/event-stream' },
      });

      if (!sseRes.ok || !sseRes.body) {
        return { ok: false, error: `SSE stream failed: ${sseRes.status}` };
      }

      let accumulatedContent = '';
      let taskStatus: 'success' | 'failed' = 'success';
      let taskError: string | undefined;

      // Parse SSE stream manually (fetch body as text with line-by-line parsing)
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') continue;
            try {
              const event = JSON.parse(dataStr) as { content?: string; status?: string; error?: string; summary?: string };
              if (event.content) accumulatedContent += event.content;
              if (event.status === 'failed' || event.error) {
                taskStatus = 'failed';
                taskError = event.error ?? event.summary ?? 'task_error received';
              }
            } catch {
              // non-JSON SSE data — ignore
            }
          }
        }
      }

      // Consume remaining buffer
      if (buffer.startsWith('data: ') && buffer.length > 6) {
        try {
          const event = JSON.parse(buffer.slice(6)) as { content?: string };
          if (event.content) accumulatedContent += event.content;
        } catch { /* ignore */ }
      }

      // Step 3: Notify callback
      if (this.taskResultCallback) {
        this.taskResultCallback(ctx.taskId, taskStatus, accumulatedContent || undefined, taskError);
      }

      if (taskStatus === 'failed') {
        return { ok: false, error: taskError ?? 'task_error', output: accumulatedContent || undefined };
      }

      return { ok: true, output: accumulatedContent || 'Task completed' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.taskResultCallback) {
        this.taskResultCallback(ctx.taskId, 'failed', undefined, msg);
      }
      return { ok: false, error: msg };
    }
  }
}
