// ── Sub-Agent Spawn Engine ──
// P3T1: spawnAgent() async generator — Normal-path-only sub-agent execution.
// Absorbed from Claude Code's AgentTool (spawnAgent + runAgent).
// Tier 1 scope: Sync execution, no Fork, no Worktree, no auto-background (those are Tier 2+).

import type { Message } from 'trimodel';
import type {
  AgentDefinition,
  AgentSpawnConfig,
  AgentSpawnResult,
  AgentType,
  SubAgentEvent,
} from './types.js';
import { getBuiltInAgent } from './built-in.js';
import { resolveAgentTools, filterToolsForAgent, buildToolCatalog } from './tools-resolve.js';
import { agentLoop, type AgentLoopOptions, type AgentEvent } from '../loop.js';
import type { PermissionRule } from '../permissions-engine/types.js';
import { resolveDefaultModel } from '../../config-sync/default-model.js';

// ── Agent ID Generator ──

let agentIdCounter = 0;

function generateAgentId(agentType: AgentType): string {
  agentIdCounter += 1;
  const short = {
    'general-purpose': 'gp',
    'explore': 'ex',
    'plan': 'pl',
    'verification': 'vf',
  }[agentType];
  return `${short}-${Date.now().toString(36)}-${agentIdCounter}`;
}

// ── System Prompt Construction ──

function buildAgentSystemPrompt(
  agentDef: AgentDefinition,
  task: string,
  resolvedTools: ReturnType<typeof resolveAgentTools>,
): string {
  const parts: string[] = [];

  // Core agent prompt
  parts.push(agentDef.systemPrompt);

  // Task assignment
  parts.push('');
  parts.push('## Task');
  parts.push(task);

  // Tool catalog
  parts.push('');
  parts.push('## Tools');
  parts.push(buildToolCatalog(resolvedTools));

  // Agent type reminder
  parts.push('');
  parts.push(`You are a \`${agentDef.agentType}\` sub-agent. Complete the assigned task and return your findings.`);

  return parts.join('\n');
}

// ── Permission Inheritance ──

function resolvePermissionMode(config: AgentSpawnConfig, agentDef: AgentDefinition): import('../permissions-engine/types.js').PermissionMode {
  // Agent definition override takes priority
  if (agentDef.permissionMode) return agentDef.permissionMode;
  // Inherit from parent
  if (config.parentPermissionMode) return config.parentPermissionMode;
  // Safe default for sub-agents
  return 'acceptEdits';
}

// ── Max Turns Resolution ──

function resolveMaxTurns(config: AgentSpawnConfig, agentDef: AgentDefinition): number {
  // Config override (explicit user override)
  if (config.maxTurns !== undefined) return config.maxTurns;
  // Agent definition default
  if (agentDef.maxTurns !== undefined) return agentDef.maxTurns;
  // Sub-agent default
  return 10;
}

// ── Event Adapter ──
// Wraps parent AgentEvents → SubAgentEvents for the spawn caller.

async function* adaptEvents(
  agentId: string,
  agentType: AgentType,
  events: AsyncGenerator<AgentEvent>,
  toolCallsCounter: { count: number },
): AsyncGenerator<SubAgentEvent> {
  for await (const event of events) {
    switch (event.type) {
      case 'content_delta':
        yield { type: 'subagent_delta', agentId, delta: event.delta };
        break;
      case 'tool_call':
        toolCallsCounter.count += 1;
        yield { type: 'subagent_tool_call', agentId, toolName: event.name };
        break;
      case 'tool_result':
        yield {
          type: 'subagent_tool_result',
          agentId,
          toolName: event.tool_call_id,
          isError: event.is_error,
        };
        break;
      case 'tool_blocked':
        // Sub-agent tool blocked — continue, let the sub-agent handle it
        break;
      case 'error':
        yield { type: 'subagent_error', agentId, error: event.message };
        break;
      // Ignore other event types in sub-agent stream
      default:
        break;
    }
  }
}

/**
 * Collect final content and metadata from a completed agent loop.
 * The last assistant message with content is treated as the result.
 */
function collectResult(
  messages: Message[],
  agentId: string,
  agentType: AgentType,
  description: string,
  toolCallsMade: number,
  turnsExecuted: number,
  finishReason?: string,
): AgentSpawnResult {
  // Find the last assistant message with text content
  let content: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.content && typeof msg.content === 'string' && msg.content.trim()) {
      content = msg.content;
      break;
    }
  }

  return {
    agentId,
    agentType,
    description,
    content,
    toolCallsMade,
    turnsExecuted,
    finishReason,
  };
}

// ── spawnAgent: Main Entry Point ──

/**
 * Spawn a sub-agent and stream its execution events.
 *
 * Normal path (Tier 1): The parent waits for the sub-agent to complete synchronously.
 * Sub-agent runs with tier='subagent' → task tool excluded → no recursive spawn.
 *
 * Usage:
 *   for await (const event of spawnAgent(config)) {
 *     if (event.type === 'subagent_done') console.log(event.result);
 *   }
 *
 * @param config - Spawn configuration (agentType, prompt, description, etc.)
 * @returns AsyncGenerator yielding SubAgentEvent stream
 */
export async function* spawnAgent(
  config: AgentSpawnConfig,
): AsyncGenerator<SubAgentEvent> {
  // 1. Resolve agent definition
  const agentDef = getBuiltInAgent(config.agentType);
  if (!agentDef) {
    yield {
      type: 'subagent_error',
      agentId: 'unknown',
      error: `Unknown agent type: ${config.agentType}`,
    };
    return;
  }

  const agentId = generateAgentId(config.agentType);

  // 2. Emit start event
  yield {
    type: 'subagent_start',
    agentId,
    agentType: config.agentType,
    description: config.description,
  };

  // 3. Resolve tools
  const resolvedTools = resolveAgentTools(agentDef);
  const filteredTools = filterToolsForAgent(resolvedTools, agentDef);

  if (filteredTools.length === 0) {
    yield {
      type: 'subagent_error',
      agentId,
      error: `Agent '${config.agentType}' has no resolved tools (declared: ${agentDef.tools.join(', ')})`,
    };
    return;
  }

  // 4. Build system prompt
  const systemPrompt = buildAgentSystemPrompt(agentDef, config.prompt, filteredTools);

  // 5. Build loop options
  // 模型名三级解析（i4-2 §四）：env > applied > 兜底常量
  const loopOptions: AgentLoopOptions = {
    model: config.model ?? agentDef.model ?? (await resolveDefaultModel()),
    maxTurns: resolveMaxTurns(config, agentDef),
    systemPrompt,
    tier: 'subagent',
    cwd: config.cwd,
    signal: config.signal,
    permissionMode: resolvePermissionMode(config, agentDef),
    permissionRules: config.parentPermissionRules,
    // No context for sub-agents (isolated execution)
  };

  // 6. Execute agent loop
  const toolCallsCounter = { count: 0 };
  let turnsExecuted = 0;
  let finalReason: string | undefined;
  const allMessages: Message[] = [];

  // ── Supervisor integration (P3.4) ──
  let logicalRunId: string | undefined;
  let logicalAbortController: AbortController | undefined;

  if (config.supervisor) {
    logicalAbortController = new AbortController();
    const managedRun = config.supervisor.registerLogicalRun({
      runId: undefined,
      scopeKey: config.supervisorScopeKey,
      replaceExistingScope: false,
      abortController: logicalAbortController,
    });
    logicalRunId = managedRun.runId;

    // If parent signal aborts, propagate to our controller
    if (config.signal) {
      if (config.signal.aborted) {
        logicalAbortController.abort(config.signal.reason);
      } else {
        config.signal.addEventListener('abort', () => {
          logicalAbortController!.abort(config.signal!.reason);
        }, { once: true });
      }
    }

    loopOptions.signal = logicalAbortController.signal;
  }

  try {
    // Run agent loop with custom tool definitions (overriding tier defaults)
    for await (const event of adaptEvents(agentId, config.agentType, agentLoop(loopOptions), toolCallsCounter)) {
      yield event;
      // Track turns from tool calls
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    yield { type: 'subagent_error', agentId, error: errorMsg };

    // Return error result
    yield {
      type: 'subagent_done',
      agentId,
      result: {
        agentId,
        agentType: config.agentType,
        description: config.description,
        content: null,
        toolCallsMade: toolCallsCounter.count,
        turnsExecuted,
        error: errorMsg,
        finishReason: 'error',
      },
    };
    return;
  } finally {
    if (config.supervisor && logicalRunId) {
      config.supervisor.finalizeLogicalRun(logicalRunId, {
        reason: 'exit',
        exitCode: 0,
        exitSignal: null,
      });
    }
  }

  // 7. Build result — extraction happens after the agentLoop completes
  // Note: We can't introspect loop internals here; AgentSpawnResult is best-effort
  // from the subagent_done event. For detailed collection, the caller should track events.
  const result: AgentSpawnResult = {
    agentId,
    agentType: config.agentType,
    description: config.description,
    content: null, // Caller extracts from delta events
    toolCallsMade: toolCallsCounter.count,
    turnsExecuted,
    finishReason: finalReason ?? 'done',
  };

  yield { type: 'subagent_done', agentId, result };
}

// ── Convenience: spawn and collect result ──

/**
 * Spawn a sub-agent and collect the final result (blocking).
 * Convenience wrapper that discards streaming events and returns only the result.
 */
export async function spawnAgentAndCollect(
  config: AgentSpawnConfig,
): Promise<AgentSpawnResult> {
  let finalResult: AgentSpawnResult | undefined;
  let collectedContent = '';

  let collectedError: string | undefined;

  for await (const event of spawnAgent(config)) {
    if (event.type === 'subagent_delta') {
      collectedContent += event.delta;
    }
    if (event.type === 'subagent_error') {
      collectedError = event.error;
    }
    if (event.type === 'subagent_done') {
      finalResult = event.result;
      // Merge collected content
      if (collectedContent && finalResult) {
        finalResult.content = collectedContent || finalResult.content;
      }
    }
  }

  if (!finalResult) {
    return {
      agentId: 'unknown',
      agentType: config.agentType,
      description: config.description,
      content: null,
      toolCallsMade: 0,
      turnsExecuted: 0,
      error: collectedError ?? 'Sub-agent did not produce a result',
      finishReason: 'error',
    };
  }

  return finalResult;
}
