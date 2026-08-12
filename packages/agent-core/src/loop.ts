// ── Agent Loop (Shared Core) ──
// Mirror of TriMC's agent-loop/loop.ts, extracted to agent-core for reuse by TriLC.
// Uses dependency injection (AgentLoopDeps) for module-specific services:
// context-builder, prompt-cache, and tool-gater.
//
// When deps are not provided, corresponding features gracefully degrade.

import {
  createModelClient,
  UsageAccumulator,
  type Message,
  type ToolCall,
  type ChatResponse,
  type StreamEvent,
  type ChatOptions,
  type UsageSummary,
  type ToolDefinition,
} from 'trimodel';
import {
  getToolDefinitions,
  executeTool,
} from './tools.js';
import {
  getTierToolCounts,
  type AgentTier,
} from './permissions.js';
import {
  PermissionEngine,
  type PermissionMode,
  type PermissionRule,
} from './permissions-engine/index.js';

// ── Deps Types (minimal contracts) ──

/** Context sources for system prompt injection (mirrors TriMC context-builder). */
export interface ContextSources {
  projectRoot?: string;
  tier?: string;
  tierSummary?: string;
  [key: string]: unknown;
}

/** Prompt cache state (mirrors TriMC prompt-cache). */
export interface CacheState {
  version: number;
  messagesHash: string;
  toolsHash: string;
  lastBreakpointTurn: number;
  breakpoints: number[];
}

/** Cache metrics for a turn (mirrors TriMC prompt-cache). */
export interface CacheMetrics {
  turn: number;
  estimatedCacheHitTokens: number;
  breakpointCount: number;
  messagesHash: string;
  toolsHash: string;
}

/** Tool spec for risk-level policy gating (mirrors TriMC tool-gater). */
export interface ToolSpec {
  name: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval?: boolean;
}

// ── AgentLoopDeps ──

/**
 * Injectable dependencies for the agent loop.
 * Each corresponds to a TriMC service module.
 * When a dep is not provided, the associated feature is skipped.
 */
export interface AgentLoopDeps {
  // ── Context Builder ──
  /** Build a context block string from ContextSources. */
  buildContext?: (sources: ContextSources) => string;
  /** Merge a context block into the system prompt. */
  mergeContextWithPrompt?: (contextBlock: string, systemPrompt?: string) => string;

  // ── Prompt Cache ──
  /** Create a new cache state for this session. */
  createCacheState?: () => CacheState;
  /** Update cache state before each API call. */
  updateCacheState?: (state: CacheState, messages: Message[], tools: ToolDefinition[], turnCount: number) => void;
  /** Build cache metrics for a turn. */
  buildCacheMetrics?: (state: CacheState, promptTokens: number, turnCount: number) => CacheMetrics;
  /** Get cache control config for a model (ephemeral breakpoints). */
  getCacheControlConfig?: (model: string) => Record<string, unknown> | undefined;

  // ── Tool Gater ──
  /** Check tool permission by tier + risk-level policy. */
  checkToolPermission?: (toolName: string, tier: AgentTier, toolSpecs?: ToolSpec[]) => { allowed: boolean; reason?: string };
}

// ── AgentLoopOptions ──

export interface AgentLoopOptions {
  /** Model name to use (default: 'deepseek-v4-pro') */
  model?: string;
  /** Fallback model for Tier 2 error recovery (default: 'deepseek-v4-flash') */
  fallbackModel?: string;
  /** Maximum conversation turns before forced exit */
  maxTurns?: number;
  /** System prompt */
  systemPrompt?: string;
  /** Initial user messages */
  messages?: Message[];
  /** Working directory for tool execution */
  cwd?: string;
  /** Context sources for system prompt injection (delegated to deps.buildContext) */
  context?: ContextSources;
  /**
   * Agent tier determines tool access.
   * - 'main' (default): Full tool access
   * - 'subagent': Restricted (read-only by default, no sub-agent spawning)
   * - 'coordinator': task tool only
   */
  tier?: AgentTier;
  /** Contract-defined tool specs for risk-level policy gating. */
  toolSpecs?: ToolSpec[];
  /** Permission mode for runtime execution decisions. */
  permissionMode?: PermissionMode;
  /** Permission rules for the engine. */
  permissionRules?: PermissionRule[];
  /** Pre-configured PermissionEngine instance (overrides permissionMode/permissionRules). */
  permissionEngine?: PermissionEngine;
  /** C9: Additional directories to treat as within-boundary for acceptEdits/dontAsk. */
  additionalDirectories?: string[];
  /**
   * Interactive permission callback (P3, additive).
   * Invoked ONLY when the decision pipeline returns behavior 'ask'
   * (i.e. an ask-rule matched and the engine did not allow the call).
   * Return 'allow' to execute once, 'always' to execute once and let the
   * caller remember the choice session-wide, 'deny' to block.
   * When omitted, 'ask' decisions keep the Tier-1 behavior: treated as deny.
   */
  onPermissionAsk?: (
    toolName: string,
    args: Record<string, unknown>,
    reason?: string,
  ) => Promise<'allow' | 'deny' | 'always'>;
  /** AbortSignal for cancelling in-flight requests. */
  signal?: AbortSignal;
  /** Injectable dependencies - gracefully degrade if not provided. */
  deps?: AgentLoopDeps;
}

// ── AgentEvent ──

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

// ── Loop State ──

interface LoopState {
  messages: Message[];
  turnCount: number;
  maxTurns: number;
  transition?: { reason: string };
}

// ── Error Classification ──

function classifyError(err: unknown): 'transient' | 'context_overflow' | 'auth' | 'permanent' {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/timeout|abort|econnreset|econnrefused|5\d\d|rate.?limit|overloaded|network/i.test(msg)) return 'transient';
  if (/413|context.?length|prompt.?too.?long|token.?limit|maximum.*context/i.test(msg)) return 'context_overflow';
  if (/401|403|unauthorized|invalid.*key|auth/i.test(msg)) return 'auth';
  return 'permanent';
}

// ── Fallback Model Map (C12) ──
//
// Two-layer fallback architecture:
//   Layer 1 (TriModel): ModelClient.stream() handles provider-level fallback
//     (e.g. tmv-deepseek-v4-pro → tmv-deepseek-chat → deepseek-v4-flash).
//     Each model's fallback is defined in TriModel's buildRegistry().
//   Layer 2 (agent-core): When TriModel exhausts all provider-level fallbacks,
//     this FALLBACK_MAP provides the ultimate model-level fallback.
//
// tmv-* models (TriStaciss-routed): their ultimate fallback always points to
// a direct-provider model (deepseek-v4-*). The tmv→tmv chain is handled by
// TriModel layer; agent-core only activates when that chain is fully exhausted.
//
// The `?? 'deepseek-v4-flash'` default in getFallbackModel() is the final
// safety net: any unknown/future model that isn't explicitly mapped will
// attempt deepseek-v4-flash as last resort.

const FALLBACK_MAP: Record<string, string> = {
  // Direct DeepSeek provider models
  'deepseek-v4-pro': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
  'deepseek-v4-flash': 'deepseek-v4-pro',

  // tmv-* (TriStaciss-routed) → ultimate fallback to direct provider.
  // TriModel layer handles tmv→tmv chaining; these entries activate
  // only when the entire tmv chain is exhausted.
  'tmv-deepseek-v4-pro': 'deepseek-v4-flash',
  'tmv-deepseek-chat': 'deepseek-v4-flash',
  'tmv-deepseek-v4-flash': 'deepseek-v4-pro',
  'tmv-deepseek-reasoner': 'deepseek-v4-flash',
};

/**
 * Resolve the ultimate fallback model for agent-core's Tier 2 recovery.
 * Always returns a string: explicit FALLBACK_MAP entry, or 'deepseek-v4-flash'
 * as the final safety net for unknown/future models.
 */
function getFallbackModel(model: string): string {
  return FALLBACK_MAP[model] ?? 'deepseek-v4-flash';
}

// ── Streaming Helper ──

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
    if (event.delta) {
      content += event.delta;
      yield { type: 'content_delta', turn, delta: event.delta };
    }

    if (event.tool_calls) {
      for (const tc of event.tool_calls) {
        const existing = toolCallMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name && existing.name !== tc.function.name) existing.name += tc.function.name;
        if (tc.function?.arguments) {
          const incoming = tc.function.arguments;
          if (incoming.startsWith(existing.arguments)) {
            existing.arguments = incoming; // cumulative snapshot (DeepSeek repeat / Anthropic accumulator)
          } else {
            existing.arguments += incoming; // incremental fragment (OpenAI standard)
          }
        }
        toolCallMap.set(tc.index, existing);
      }
    }

    if (event.finish_reason !== undefined) finishReason = event.finish_reason;
    if (event.usage) usage = event.usage;
  }

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

// ── Agent Loop Iterator ──

export async function* agentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const model = options.model ?? 'deepseek-v4-pro';
  const fallbackModel = options.fallbackModel ?? getFallbackModel(model);
  const maxTurns = options.maxTurns ?? 25;
  const tier = options.tier ?? 'main';
  const deps = options.deps ?? {};
  const modelClient = createModelClient();
  const allTools = getToolDefinitions();
  const tools = getToolDefinitions(tier);

  // Context building (graceful degrade if deps not provided)
  let effectiveSystemPrompt = options.systemPrompt;
  if (options.context && deps.buildContext && deps.mergeContextWithPrompt) {
    const contextBlock = deps.buildContext(options.context);
    effectiveSystemPrompt = deps.mergeContextWithPrompt(contextBlock, options.systemPrompt);
  }

  // Build initial messages
  const seedMessages: Message[] = [];
  if (effectiveSystemPrompt) {
    seedMessages.push({ role: 'system', content: effectiveSystemPrompt });
  }
  if (options.messages) {
    seedMessages.push(...options.messages);
  }

  // Spread-replace state
  let state: LoopState = {
    messages: seedMessages,
    turnCount: 1,
    maxTurns,
  };

  const accumulator = new UsageAccumulator();

  // Prompt cache (graceful degrade)
  const cacheState: CacheState = deps.createCacheState?.() ?? {
    version: 0,
    messagesHash: '',
    toolsHash: '',
    lastBreakpointTurn: 0,
    breakpoints: [],
  };
  deps.updateCacheState?.(cacheState, seedMessages, tools, 0);

  // Permission engine
  const permissionEngine = options.permissionEngine ??
    new PermissionEngine({
      mode: options.permissionMode ?? 'bypassPermissions',
      rules: options.permissionRules ?? [],
      cwd: options.cwd,
      additionalDirectories: options.additionalDirectories ?? [],
    });

  // Tier tool counts for loop_start
  const tierCounts = getTierToolCounts(allTools);
  const tierToolCount = tierCounts[tier].count;
  const totalToolCount = tierCounts.main.count;

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

  let currentModel = model;
  let hasAttemptedFallback = false;

  while (true) {
    // Abort check
    if (options.signal?.aborted) {
      yield { type: 'loop_end', reason: 'aborted', usageSummary: accumulator.summary() };
      return;
    }

    // Max turns guard
    if (state.turnCount > maxTurns) {
      yield { type: 'loop_end', reason: 'max_turns', usageSummary: accumulator.summary() };
      return;
    }

    yield { type: 'request_start', turn: state.turnCount, model: currentModel };

    // Update cache state
    deps.updateCacheState?.(cacheState, state.messages, tools, state.turnCount);

    let response: ChatResponse | undefined;
    let recoveryTier: 1 | 2 | 0 = 0;
    hasAttemptedFallback = false;

    try {
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

      if (category === 'auth' || category === 'context_overflow') {
        yield { type: 'error', message: errMsg };
        yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
        return;
      }

      // Tier 1: Retry same model
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
          const retryCategory = classifyError(retryErr);
          if (retryCategory === 'auth' || retryCategory === 'context_overflow') {
            const m = retryErr instanceof Error ? retryErr.message : String(retryErr);
            yield { type: 'error', message: m };
            yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
            return;
          }
        }
      }

      // Tier 2: Switch to fallback model
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

      // Tier 3: All recovery exhausted
      if (!response) {
        yield { type: 'error', message: errMsg };
        yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
        return;
      }
    }

    accumulator.add(response);

    // Cache metrics
    if (response.usage && deps.buildCacheMetrics) {
      const metrics = deps.buildCacheMetrics(cacheState, response.usage.prompt_tokens, state.turnCount);
      yield { type: 'cache_metrics', metrics };
    }

    // Emit assistant response
    yield {
      type: 'assistant_message',
      turn: state.turnCount,
      content: response.content,
      tool_calls: response.tool_calls,
    };

    // Spread-replace: push assistant message
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

    // Check for tool calls
    if (!response.tool_calls || response.tool_calls.length === 0) {
      yield {
        type: 'loop_end',
        reason: 'done',
        finish_reason: response.finish_reason ?? undefined,
        usageSummary: accumulator.summary(),
      };
      return;
    }

    // Execute tools (2.4: timeout + failure tracking)
    const TOOL_TIMEOUT_MS = 120_000; // 120s default
    const toolResults: Message[] = [];
    let consecutiveToolFailures = 0;
    const lastToolErrors = new Map<string, string>(); // toolName → last error message

    for (const tc of response.tool_calls) {
      yield { type: 'tool_call', turn: state.turnCount, id: tc.id, name: tc.function.name, arguments: tc.function.arguments };

      let args: Record<string, unknown> = {};
      try {
        args = typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function.arguments as Record<string, unknown>);
      } catch {
        args = {};
      }

      // Permission Engine check
      const engineDecision = permissionEngine.decide(tc.function.name, args);
      if (!engineDecision.allowed) {
        // P3: 'ask' decisions can be resolved interactively when the host
        // provides onPermissionAsk (e.g. TriLC TUI permission prompt).
        if (engineDecision.behavior === 'ask' && options.onPermissionAsk) {
          const verdict = await options.onPermissionAsk(
            tc.function.name,
            args,
            engineDecision.reason,
          );
          if (verdict === 'deny') {
            const blockReason = `User denied permission for tool "${tc.function.name}"`;
            yield {
              type: 'tool_blocked',
              turn: state.turnCount,
              tool_name: tc.function.name,
              reason: blockReason,
            };
            toolResults.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: blockReason }),
            });
            continue;
          }
          // 'allow' | 'always' → fall through to execution.
          // ('always' session memory is the callback's responsibility.)
        } else {
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
      }

      // Tool Gater check (graceful degrade)
      if (deps.checkToolPermission) {
        const tierPermission = deps.checkToolPermission(tc.function.name, tier, options.toolSpecs);
        if (!tierPermission.allowed) {
          yield {
            type: 'tool_blocked',
            turn: state.turnCount,
            tool_name: tc.function.name,
            reason: tierPermission.reason ?? 'unknown',
          };
          toolResults.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Tool "${tc.function.name}" blocked at tier "${tier}": ${tierPermission.reason}` }),
          });
          continue;
        }
      }

      // REQ-014b: pass agent loop cwd to tools (NOT process.cwd())
      // 2.4: Tool execution timeout protection (default 120s)
      let resultContent: string;
      let isError = false;
      try {
        const toolPromise = executeTool(tc.function.name, args, { cwd: options.cwd });
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool "${tc.function.name}" execution timeout (${TOOL_TIMEOUT_MS / 1000}s)`)), TOOL_TIMEOUT_MS),
        );
        resultContent = await Promise.race([toolPromise, timeoutPromise]);
        isError = resultContent.includes('"error"');
      } catch (execErr) {
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        resultContent = JSON.stringify({ error: errMsg });
        isError = true;
        // 2.4: Timeout or exception yields tool_blocked
        yield {
          type: 'tool_blocked',
          turn: state.turnCount,
          tool_name: tc.function.name,
          reason: errMsg,
        };
      }

      // 2.4: Failure tracking — consecutive failures + repeat error detection
      if (isError) {
        consecutiveToolFailures++;
        const prevError = lastToolErrors.get(tc.function.name);
        const currentError = resultContent.slice(0, 200);
        if (prevError && prevError === currentError) {
          yield {
            type: 'tool_blocked',
            turn: state.turnCount,
            tool_name: tc.function.name,
            reason: `Repeated identical failure for tool "${tc.function.name}" — possible loop`,
          };
        }
        lastToolErrors.set(tc.function.name, currentError);
      } else {
        consecutiveToolFailures = 0;
        lastToolErrors.delete(tc.function.name);
      }

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

    // 2.4: Consecutive failure loop breaker — 3 failures → abort
    if (consecutiveToolFailures >= 3) {
      yield {
        type: 'tool_blocked',
        turn: state.turnCount,
        tool_name: '(system)',
        reason: `${consecutiveToolFailures} consecutive tool failures — aborting task`,
      };
      yield { type: 'error', message: `${consecutiveToolFailures} consecutive tool failures — aborting` };
      yield { type: 'loop_end', reason: 'error', usageSummary: accumulator.summary() };
      return;
    }

    // Spread-replace: push tool results + increment turn
    state = {
      ...state,
      messages: [...state.messages, ...toolResults],
      turnCount: state.turnCount + 1,
      transition: recoveryTier > 0 ? { reason: recoveryTier === 1 ? 'model_hiccup' : 'model_swap' } : { reason: 'next_turn' },
    };
  }
}

// ── Run to Completion ──

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