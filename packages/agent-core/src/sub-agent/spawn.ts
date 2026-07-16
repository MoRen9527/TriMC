// Sub-agent spawn — spawnAgent with event adaptation
// Shared between TriMC and TriLC

import { randomUUID } from 'node:crypto';
import { agentLoop, type AgentLoopOptions, type AgentEvent } from '../loop.js';
import type { AgentTier } from '../permissions.js';
import type { SpawnConfig, SubAgentEvent } from './types.js';

/**
 * Spawn a sub-agent and yield events as it runs.
 *
 * Usage:
 *   for await (const event of spawnAgent(config)) {
 *     if (event.type === 'done') break;
 *   }
 */
export async function* spawnAgent(config: SpawnConfig): AsyncGenerator<SubAgentEvent> {
  const agentId = randomUUID();
  const startTime = Date.now();

  // Emit start event
  yield {
    type: 'start',
    agentId,
    agentName: config.agent.name,
    timestamp: startTime,
    data: { task: config.task },
  };

  // Build agent-loop options from SpawnConfig
  const loopOptions: AgentLoopOptions = {
    systemPrompt: buildSubAgentPrompt(config),
    model: config.agent.model,
    tier: (config.agent.tier as AgentTier) ?? 'subagent',
    maxTurns: config.maxTurns ?? config.agent.maxTurns ?? 10,
    messages: config.context
      ? [{ role: 'user', content: config.context }]
      : undefined,
  };

  try {
    // Run the agent loop and adapt events
    for await (const event of agentLoop(loopOptions)) {
      const adapted = adaptEvent(event, agentId, config.agent.name);
      if (adapted) yield adapted;

      // Check timeout (stop on loop_end or error)
      if (event.type === 'loop_end' || event.type === 'error') break;

      if (config.timeout && (Date.now() - startTime > config.timeout)) {
        yield {
          type: 'error',
          agentId,
          agentName: config.agent.name,
          timestamp: Date.now(),
          data: { message: `Sub-agent timed out after ${config.timeout}ms` },
        };
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield {
      type: 'error',
      agentId,
      agentName: config.agent.name,
      timestamp: Date.now(),
      data: { message },
    };
  }
}

/**
 * Build system prompt for a sub-agent from SpawnConfig.
 */
function buildSubAgentPrompt(config: SpawnConfig): string {
  let prompt = config.agent.systemPrompt ?? `You are the "${config.agent.name}" sub-agent.`;

  prompt += `\n\nYour task: ${config.task}`;

  if (config.context) {
    prompt += `\n\nContext from parent agent:\n${config.context}`;
  }

  prompt += `\n\nComplete your task efficiently. Report when done.`;
  return prompt;
}

/**
 * Adapt AgentEvent (from agent-loop discriminated union) to SubAgentEvent.
 */
function adaptEvent(
  event: AgentEvent,
  agentId: string,
  agentName: string,
): SubAgentEvent | null {
  const now = Date.now();

  switch (event.type) {
    case 'loop_start':
      // Skip — sub-agent internal start, not exposed to caller
      return null;

    case 'request_start':
    case 'content_delta':
    case 'cache_metrics':
    case 'recovery':
      // Internal events — not exposed to sub-agent caller
      return null;

    case 'assistant_message':
      return {
        type: 'message',
        agentId,
        agentName,
        timestamp: now,
        data: { content: event.content },
      };

    case 'tool_call':
      return {
        type: 'tool_call',
        agentId,
        agentName,
        timestamp: now,
        data: { id: event.id, name: event.name, arguments: event.arguments },
      };

    case 'tool_result':
      return {
        type: 'tool_result',
        agentId,
        agentName,
        timestamp: now,
        data: { tool_call_id: event.tool_call_id, content: event.content, is_error: event.is_error },
      };

    case 'tool_blocked':
      return {
        type: 'tool_blocked',
        agentId,
        agentName,
        timestamp: now,
        data: { tool_name: event.tool_name, reason: event.reason },
      };

    case 'loop_end':
      return {
        type: 'done',
        agentId,
        agentName,
        timestamp: now,
        data: { reason: event.reason, finish_reason: event.finish_reason, usageSummary: event.usageSummary },
      };

    case 'error':
      return {
        type: 'error',
        agentId,
        agentName,
        timestamp: now,
        data: { message: event.message },
      };

    default:
      return null;
  }
}

/**
 * Run spawnAgent to completion and return all events.
 * Convenience wrapper for non-streaming use cases.
 */
export async function spawnAgentComplete(config: SpawnConfig): Promise<SubAgentEvent[]> {
  const events: SubAgentEvent[] = [];
  for await (const event of spawnAgent(config)) {
    events.push(event);
  }
  return events;
}
