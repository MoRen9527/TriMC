// ── TriMC Agent Loop ──
// Absorbed from Claude Code 2.1.88 vendor pattern (query.ts queryLoop).
// Uses TriModel (DeepSeek provider) instead of Anthropic SDK.
// Phase 1: while-true loop with tool dispatching via built-in registry.

import { createModelClient, UsageAccumulator, type Message, type ToolCall, type UsageSummary } from 'trimodel';
import { getToolDefinitions, executeTool } from './tools.js';
import { canUseTool, getTierSummary, type AgentTier } from './permissions.js';

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
   * CTO-008: Agent tier determines tool access.
   * - 'main' (default): All 6 built-in tools
   * - 'subagent': read_file, glob_search, shell_exec, write_file, edit_file (no task — prevents recursion)
   * - 'coordinator': task only
   */
  tier?: AgentTier;
}

// ── Streaming Event Types ──

export type AgentEvent =
  | { type: 'loop_start'; model: string; turn: number; tier?: string; availableTools?: number; totalTools?: number }
  | { type: 'request_start'; turn: number }
  | { type: 'assistant_message'; turn: number; content: string | null; tool_calls?: ToolCall[] }
  | { type: 'tool_call'; turn: number; tool_call: ToolCall }
  | { type: 'tool_result'; turn: number; tool_call_id: string; content: string; is_error?: boolean }
  | { type: 'tool_blocked'; turn: number; tool_name: string; reason: string }
  | { type: 'loop_end'; reason: 'done' | 'max_turns' | 'error' | 'tool_calls_finish'; finish_reason?: string; usage?: UsageSummary }
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

  // Build initial messages array
  const seedMessages: Message[] = [];
  if (options.systemPrompt) {
    seedMessages.push({ role: 'system', content: options.systemPrompt });
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
      yield { type: 'loop_end', reason: 'max_turns', usage: accumulator.summary() };
      return;
    }

    // ── Call model ──
    yield { type: 'request_start', turn: state.turnCount };

    let response;
    try {
      response = await modelClient.chat(model, state.messages, { tools: tools.length > 0 ? tools : undefined });
      accumulator.add(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
      yield { type: 'loop_end', reason: 'error', usage: accumulator.summary() };
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
        usage: accumulator.summary(),
      };
      return;
    }

    // ── Execute tools ──
    const toolResults: Message[] = [];
    for (const tc of response.tool_calls) {
      yield { type: 'tool_call', turn: state.turnCount, tool_call: tc };

      // CTO-008: Permission check before execution
      const permission = canUseTool(tc.function.name, tier);
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
  usage: UsageSummary | undefined;
}> {
  const events: AgentEvent[] = [];
  let finalMessage: string | null = null;
  let usage: UsageSummary | undefined;

  for await (const event of agentLoop(options)) {
    events.push(event);
    if (event.type === 'assistant_message' && event.content) {
      finalMessage = event.content;
    }
    if (event.type === 'loop_end') {
      usage = event.usage;
    }
  }

  return { events, finalMessage, usage };
}
