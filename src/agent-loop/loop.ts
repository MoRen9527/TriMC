// ── TriMC Agent Loop ──
// Absorbed from Claude Code 2.1.88 vendor pattern (query.ts queryLoop).
// Uses TriModel (DeepSeek provider) instead of Anthropic SDK.
// Phase 1: while-true loop with tool dispatching via built-in registry.

import { createModelClient, UsageAccumulator, type Message, type ToolCall, type UsageSummary } from 'trimodel';
import { getToolDefinitions, executeTool } from './tools.js';
import { getTierSummary, type AgentTier } from './permissions.js';
import { buildContext, mergeContextWithPrompt, type ContextSources } from '../context-builder/context-builder.js';
import { checkToolPermission, type ToolSpec } from '../tool-gater/gater.js';
import {
  createCacheState,
  updateCacheState,
  buildCacheMetrics,
  getCacheControlConfig,
  type CacheState,
  type CacheMetrics,
} from '../prompt-cache/index.js';

// ── Query Options ──

export interface AgentLoopOptions {
  /** Model name to use (default: 'deepseek-v4-pro') */
  model?: string;
  /** Maximum conversation turns before forced exit */
  maxTurns?: number;
  /** System prompt */
  systemPrompt?: string;
  /** Initial user messages */
  messages?: Message[];
  /** Working directory for tool execution */
  cwd?: string;
  /**
   * CTO-004: Context sources for system prompt injection.
   * When provided, buildContext() assembles project background (AGENTS.md, registry, tier capabilities)
   * and merges it as a prefix before the user's system prompt.
   */
  context?: ContextSources;
  /**
   * CTO-008: Agent tier determines tool access.
   * - 'main' (default): All 6 built-in tools
   * - 'subagent': read_file, glob_search, shell_exec, write_file, edit_file (no task — prevents recursion)
   * - 'coordinator': task only
   */
  tier?: AgentTier;
  /**
   * CTO-011: Contract-defined tool specs for risk-level policy gating.
   * When provided, checkToolPermission() combines tier check with
   * risk-level evaluation (low→auto, medium→audit, high→block, critical→deny).
   * When omitted, only tier check applies (backward compatible).
   */
  toolSpecs?: ToolSpec[];
}

// ── Streaming Event Types ──

export type AgentEvent =
  | { type: 'loop_start'; model: string; turn: number; tier?: string; availableTools?: number; totalTools?: number }
  | { type: 'request_start'; turn: number }
  | { type: 'assistant_message'; turn: number; content: string | null; tool_calls?: ToolCall[] }
  | { type: 'tool_call'; turn: number; id: string; name: string; arguments: string }
  | { type: 'tool_result'; turn: number; tool_call_id: string; content: string; is_error?: boolean }
  | { type: 'tool_blocked'; turn: number; tool_name: string; reason: string }
  | { type: 'loop_end'; reason: 'done' | 'max_turns' | 'error' | 'tool_calls_finish'; finish_reason?: string; usageSummary?: UsageSummary }
  | { type: 'cache_metrics'; metrics: CacheMetrics }
  | { type: 'error'; message: string };

// ── Agent Loop State (mirrors Claude Code State pattern) ──

interface LoopState {
  messages: Message[];
  turnCount: number;
  maxTurns: number;
}

// ── Agent Loop Iterator ──

export async function* agentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const model = options.model ?? 'deepseek-v4-pro';
  const maxTurns = options.maxTurns ?? 25;
  const tier = options.tier ?? 'main';
  const modelClient = createModelClient();
  const allTools = getToolDefinitions();
  const tools = getToolDefinitions(tier); // CTO-008: tier-filtered tools

  // CTO-004: Build context prefix from ContextSources if provided
  let effectiveSystemPrompt = options.systemPrompt;
  if (options.context) {
    const contextBlock = buildContext(options.context);
    effectiveSystemPrompt = mergeContextWithPrompt(contextBlock, options.systemPrompt);
  }

  // Build initial messages array
  const seedMessages: Message[] = [];
  if (effectiveSystemPrompt) {
    seedMessages.push({ role: 'system', content: effectiveSystemPrompt });
  }
  if (options.messages) {
    seedMessages.push(...options.messages);
  }

  const state: LoopState = {
    messages: seedMessages,
    turnCount: 1,
    maxTurns,
  };

  const accumulator = new UsageAccumulator();

  // CTO-003 P0: Initialize prompt cache state for this session
  const cacheState: CacheState = createCacheState();
  updateCacheState(cacheState, seedMessages, tools, 0);
  const cacheConfig = getCacheControlConfig(model);

  // CTO-008: Log tier info on start
  const tierSummary = getTierSummary();
  const tierToolCount = tierSummary[tier].count;
  const totalToolCount = tierSummary.main.count;

  yield {
    type: 'loop_start',
    model,
    turn: state.turnCount,
    tier,
    availableTools: tierToolCount,
    totalTools: totalToolCount,
  } as AgentEvent;

  while (true) {
    // ── Max turns guard ──
    if (state.turnCount > maxTurns) {
      yield { type: 'loop_end', reason: 'max_turns', usageSummary: accumulator.summary() };
      return;
    }

    // ── Call model ──
    yield { type: 'request_start', turn: state.turnCount };

    let response;
    try {
      // CTO-003 P0: Update cache state before API call (detect system/tool changes)
      updateCacheState(cacheState, state.messages, tools, state.turnCount);

      response = await modelClient.chat(model, state.messages, { tools: tools.length > 0 ? tools : undefined });
      accumulator.add(response);

      // CTO-003 P0: Build and yield cache metrics for this turn
      if (response.usage) {
        const metrics = buildCacheMetrics(cacheState, response.usage.prompt_tokens, state.turnCount);
        yield { type: 'cache_metrics', metrics };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
      yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
      return;
    }

    // ── Emit assistant response ──
    yield {
      type: 'assistant_message',
      turn: state.turnCount,
      content: response.content,
      tool_calls: response.tool_calls,
    };

    // Push assistant message to history
    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
    };
    if (response.tool_calls && response.tool_calls.length > 0) {
      assistantMsg.tool_calls = response.tool_calls;
    }
    state.messages.push(assistantMsg);

    // ── Check for tool calls ──
    if (!response.tool_calls || response.tool_calls.length === 0) {
      yield {
        type: 'loop_end',
        reason: 'done',
        finish_reason: response.finish_reason ?? undefined,
        usageSummary: accumulator.summary(),
      };
      return;
    }

    // ── Execute tools ──
    const toolResults: Message[] = [];
    for (const tc of response.tool_calls) {
      yield { type: 'tool_call', turn: state.turnCount, id: tc.id, name: tc.function.name, arguments: tc.function.arguments };

      // CTO-011: Unified permission check (tier + risk-level policy gate)
      const permission = checkToolPermission(tc.function.name, tier, options.toolSpecs);
      if (!permission.allowed) {
        const blockMsg = `Tool "${tc.function.name}" blocked at tier "${tier}": ${permission.reason}`;
        yield {
          type: 'tool_blocked',
          turn: state.turnCount,
          tool_name: tc.function.name,
          reason: permission.reason ?? 'unknown',
        };
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: blockMsg }),
        });
        continue;
      }

      let args: Record<string, unknown> = {};
      try {
        args = typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function.arguments as Record<string, unknown>);
      } catch {
        args = {};
      }

      const resultContent = await executeTool(tc.function.name, args);
      const isError = resultContent.includes('"error"');

      yield {
        type: 'tool_result',
        turn: state.turnCount,
        tool_call_id: tc.id,
        content: resultContent,
        is_error: isError,
      };

      toolResults.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultContent,
      });
    }

    // Push tool results to history
    state.messages.push(...toolResults);
    state.turnCount++;
  }
}

// ── Run agent loop to completion (non-streaming convenience) ──

export async function runAgentLoop(options: AgentLoopOptions): Promise<{
  events: AgentEvent[];
  finalMessage: string | null;
  usageSummary: UsageSummary | undefined;
}> {
  const events: AgentEvent[] = [];
  let finalMessage: string | null = null;
  let usageSummary: UsageSummary | undefined;

  for await (const event of agentLoop(options)) {
    events.push(event);
    if (event.type === 'assistant_message' && event.content) {
      finalMessage = event.content;
    }
    if (event.type === 'loop_end') {
      usageSummary = event.usageSummary;
    }
  }

  return { events, finalMessage, usageSummary };
}
