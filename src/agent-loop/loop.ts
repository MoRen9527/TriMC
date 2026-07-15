// ── TriMC Agent Loop ──
// Absorbed from Claude Code 2.1.88 vendor pattern (query.ts queryLoop).
// Uses TriModel (DeepSeek provider) instead of Anthropic SDK.
// Phase 1: while-true loop with tool dispatching via built-in registry.
// CTO-003 P1T1: Spread-replace state + three-tier error recovery cascade + abort + streaming.

import { createModelClient, UsageAccumulator, type Message, type ToolCall, type ChatResponse, type StreamEvent, type ChatOptions, type UsageSummary } from 'trimodel';
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
import { PermissionEngine, type PermissionEngineOptions } from './permissions-engine/index.js';
import type { PermissionMode, PermissionRule } from './permissions-engine/types.js';

// ── Query Options ──

export interface AgentLoopOptions {
  /** Model name to use (default: 'deepseek-v4-pro') */
  model?: string;
  /** Fallback model for Tier 2 error recovery (default: 'deepseek-chat') */
  fallbackModel?: string;
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
  /**
   * CTO-003 P4T1: Permission mode for runtime execution decisions.
   * - 'default': Rules + safety check apply. Default deny without matching allow rule.
   * - 'acceptEdits': Auto-accept write_file/edit_file within CWD (other tools default deny).
   * - 'bypassPermissions': Allow all tools except deny rules and safety checks.
   * When not set, defaults to 'bypassPermissions' (transparent — relies on tier+gater).
   */
  permissionMode?: PermissionMode;
  /**
   * CTO-003 P4T1: Permission rules for the engine.
   * Claude Code-compatible rules parsed via parseRule().
   */
  permissionRules?: PermissionRule[];
  /**
   * CTO-003 P4T1: Pre-configured PermissionEngine instance.
   * When provided, permissionMode and permissionRules are ignored.
   */
  permissionEngine?: PermissionEngine;
  /**
   * CTO-003 P1: AbortSignal for cancelling in-flight requests.
   * When the signal is aborted, the loop terminates gracefully.
   */
  signal?: AbortSignal;
}

// ── Streaming Event Types ──

export type AgentEvent =
  | { type: 'loop_start'; model: string; fallbackModel?: string; turn: number; tier?: string; availableTools?: number; totalTools?: number; permissionMode?: string; permissionRules?: number }
  | { type: 'request_start'; turn: number; model: string }
  | { type: 'content_delta'; turn: number; delta: string }
  | { type: 'assistant_message'; turn: number; content: string | null; tool_calls?: ToolCall[] }
  | { type: 'tool_call'; turn: number; id: string; name: string; arguments: string }
  | { type: 'tool_result'; turn: number; tool_call_id: string; content: string; is_error?: boolean }
  | { type: 'tool_blocked'; turn: number; tool_name: string; reason: string }
  | { type: 'loop_end'; reason: 'done' | 'max_turns' | 'error' | 'tool_calls_finish' | 'aborted'; finish_reason?: string; usageSummary?: UsageSummary }
  | { type: 'cache_metrics'; metrics: CacheMetrics }
  | { type: 'recovery'; turn: number; tier: 1 | 2; message: string }
  | { type: 'error'; message: string };

// ── Agent Loop State (spread-replace pattern per Claude Code State design) ──

interface LoopState {
  messages: Message[];
  turnCount: number;
  maxTurns: number;
  /** CTO-003 P1: Transition reason for this cycle (Tier 2+ continue sites) */
  transition?: { reason: string };
}

// ── Error Classification (CTO-003 P1) ──
// Maps errors to recovery tiers for the three-tier cascade.

function classifyError(err: unknown): 'transient' | 'context_overflow' | 'auth' | 'permanent' {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/timeout|abort|econnreset|econnrefused|5\d\d|rate.?limit|overloaded|network/i.test(msg)) return 'transient';
  if (/413|context.?length|prompt.?too.?long|token.?limit|maximum.*context/i.test(msg)) return 'context_overflow';
  if (/401|403|unauthorized|invalid.*key|auth/i.test(msg)) return 'auth';
  return 'permanent';
}

// ── Fallback Model Map (CTO-003 P1) ──
// Simple model downgrade path for Tier 2 recovery.
// Default: v4-pro → chat, reasoner → chat, flash → v4-pro.

const FALLBACK_MAP: Record<string, string> = {
  'deepseek-v4-pro': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-chat',
  'deepseek-v4-flash': 'deepseek-v4-pro',
};

function getFallbackModel(model: string): string | undefined {
  return FALLBACK_MAP[model] ?? 'deepseek-chat';
}

// ── Streaming Helper (CTO-003 P1T1) ──
// Wraps modelClient.stream() → yields content_delta events → returns accumulated ChatResponse.

async function* streamChat(
  modelClient: ReturnType<typeof createModelClient>,
  model: string,
  messages: Message[],
  opts: ChatOptions,
  turn: number,
): AsyncGenerator<AgentEvent, ChatResponse> {
  let content = '';
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: ChatResponse['finish_reason'] = null;
  let usage: ChatResponse['usage'] | undefined;

  for await (const event of modelClient.stream(model, messages, opts)) {
    // Accumulate text deltas
    if (event.delta) {
      content += event.delta;
      yield { type: 'content_delta', turn, delta: event.delta };
    }

    // Accumulate tool call fragments (incremental, merge by index)
    if (event.tool_calls) {
      for (const tc of event.tool_calls) {
        const existing = toolCallMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        toolCallMap.set(tc.index, existing);
      }
    }

    if (event.finish_reason !== undefined) finishReason = event.finish_reason;
    if (event.usage) usage = event.usage;
  }

  // Build final tool_calls array from accumulated fragments
  const tool_calls: ToolCall[] = Array.from(toolCallMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));

  return {
    id: `stream-${turn}`,
    model,
    content: content || null,
    tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
    finish_reason: finishReason,
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Agent Loop Iterator (CTO-003 P1T1 refactored) ──

export async function* agentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const model = options.model ?? 'deepseek-v4-pro';
  const fallbackModel = options.fallbackModel ?? getFallbackModel(model);
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

  // CTO-003 P1: Spread-replace state initialization
  let state: LoopState = {
    messages: seedMessages,
    turnCount: 1,
    maxTurns,
  };

  const accumulator = new UsageAccumulator();

  // CTO-003 P0: Initialize prompt cache state for this session
  const cacheState: CacheState = createCacheState();
  updateCacheState(cacheState, seedMessages, tools, 0);
  const cacheConfig = getCacheControlConfig(model);

  // CTO-003 P4T1: Initialize permission engine
  // When not explicitly configured, default to bypassPermissions so the engine
  // is transparent (safety checks only) — tier+gater handles the other checks.
  const permissionEngine = options.permissionEngine ??
    new PermissionEngine({
      mode: options.permissionMode ?? 'bypassPermissions',
      rules: options.permissionRules ?? [],
      cwd: options.cwd,
    });

  // CTO-008: Log tier info on start
  const tierSummary = getTierSummary();
  const tierToolCount = tierSummary[tier].count;
  const totalToolCount = tierSummary.main.count;

  yield {
    type: 'loop_start',
    model,
    fallbackModel,
    turn: state.turnCount,
    tier,
    availableTools: tierToolCount,
    totalTools: totalToolCount,
    permissionMode: permissionEngine.getMode(),
    permissionRules: permissionEngine.getRules().length,
  } as AgentEvent;

  // CTO-003 P1: Track current model (may change on fallback)
  let currentModel = model;
  // Track whether we've already attempted fallback this turn (prevent fallback loop)
  let hasAttemptedFallback = false;

  while (true) {
    // ── Abort check (CTO-003 P1) ──
    if (options.signal?.aborted) {
      yield { type: 'loop_end', reason: 'aborted', usageSummary: accumulator.summary() };
      return;
    }

    // ── Max turns guard ──
    if (state.turnCount > maxTurns) {
      yield { type: 'loop_end', reason: 'max_turns', usageSummary: accumulator.summary() };
      return;
    }

    // ── Call model with three-tier error recovery cascade ──
    yield { type: 'request_start', turn: state.turnCount, model: currentModel };

    // CTO-003 P0: Update cache state before API call (detect system/tool changes)
    updateCacheState(cacheState, state.messages, tools, state.turnCount);

    let response;
    let recoveryTier: 1 | 2 | 0 = 0; // 0 = no recovery needed
    hasAttemptedFallback = false;

    try {
      // Primary attempt (streaming)
      response = yield* streamChat(
        modelClient,
        currentModel,
        state.messages,
        { tools: tools.length > 0 ? tools : undefined },
        state.turnCount,
      );
    } catch (err) {
      const category = classifyError(err);
      const errMsg = err instanceof Error ? err.message : String(err);

      // Unrecoverable: auth errors, context overflow — surface immediately
      if (category === 'auth' || category === 'context_overflow') {
        yield { type: 'error', message: errMsg };
        yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
        return;
      }

      // ── Tier 1: Retry same model (model hiccup) ──
      if (category === 'transient') {
        recoveryTier = 1;
        yield { type: 'recovery', turn: state.turnCount, tier: 1, message: `Model hiccup on ${currentModel}, retrying...` };
        try {
          response = yield* streamChat(
            modelClient,
            currentModel,
            state.messages,
            { tools: tools.length > 0 ? tools : undefined },
            state.turnCount,
          );
        } catch (retryErr) {
          // Tier 1 retry also failed — fall through to Tier 2
          const retryCategory = classifyError(retryErr);
          if (retryCategory === 'auth' || retryCategory === 'context_overflow') {
            const m = retryErr instanceof Error ? retryErr.message : String(retryErr);
            yield { type: 'error', message: m };
            yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
            return;
          }
          // Fall through to Tier 2 below
        }
      }

      // ── Tier 2: Switch to fallback model ──
      if (!response && !hasAttemptedFallback && fallbackModel && fallbackModel !== currentModel) {
        recoveryTier = 2;
        hasAttemptedFallback = true;
        yield { type: 'recovery', turn: state.turnCount, tier: 2, message: `Switching from ${currentModel} to ${fallbackModel}...` };
        try {
          currentModel = fallbackModel;
          response = yield* streamChat(
            modelClient,
            currentModel,
            state.messages,
            { tools: tools.length > 0 ? tools : undefined },
            state.turnCount,
          );
        } catch (fallbackErr) {
          const m = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          yield { type: 'error', message: m };
          yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
          return;
        }
      }

      // ── Tier 3: All recovery exhausted — surface and terminate ──
      if (!response) {
        yield { type: 'error', message: errMsg };
        yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
        return;
      }
    }

    accumulator.add(response);

    // CTO-003 P0: Build and yield cache metrics for this turn
    if (response.usage) {
      const metrics = buildCacheMetrics(cacheState, response.usage.prompt_tokens, state.turnCount);
      yield { type: 'cache_metrics', metrics };
    }

    // ── Emit assistant response ──
    yield {
      type: 'assistant_message',
      turn: state.turnCount,
      content: response.content,
      tool_calls: response.tool_calls,
    };

    // CTO-003 P1: Spread-replace — build assistant message, push to history
    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
    };
    if (response.tool_calls && response.tool_calls.length > 0) {
      assistantMsg.tool_calls = response.tool_calls;
    }
    state = {
      ...state,
      messages: [...state.messages, assistantMsg],
    };

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

      // Parse tool arguments early (needed for both permission layers)
      let args: Record<string, unknown> = {};
      try {
        args = typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function.arguments as Record<string, unknown>);
      } catch {
        args = {};
      }

      // CTO-003 P4T1: Permission Engine check (runtime per-invocation decisions)
      const engineDecision = permissionEngine.decide(tc.function.name, args);
      if (!engineDecision.allowed) {
        const blockReason = engineDecision.reason ?? `Blocked by permission engine (${engineDecision.decidedBy})`;
        yield {
          type: 'tool_blocked',
          turn: state.turnCount,
          tool_name: tc.function.name,
          reason: blockReason,
        };
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: `Tool "${tc.function.name}" blocked: ${blockReason}`,
            permission_decision: engineDecision,
          }),
        });
        continue;
      }

      // CTO-011: Tier + risk-level policy gate (second layer after permission engine)
      const tierPermission = checkToolPermission(tc.function.name, tier, options.toolSpecs);
      if (!tierPermission.allowed) {
        const blockMsg = `Tool "${tc.function.name}" blocked at tier "${tier}": ${tierPermission.reason}`;
        yield {
          type: 'tool_blocked',
          turn: state.turnCount,
          tool_name: tc.function.name,
          reason: tierPermission.reason ?? 'unknown',
        };
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: blockMsg }),
        });
        continue;
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

    // CTO-003 P1: Spread-replace — push tool results + increment turn
    state = {
      ...state,
      messages: [...state.messages, ...toolResults],
      turnCount: state.turnCount + 1,
      transition: recoveryTier > 0 ? { reason: recoveryTier === 1 ? 'model_hiccup' : 'model_swap' } : { reason: 'next_turn' },
    };
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
