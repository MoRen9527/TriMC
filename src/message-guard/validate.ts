/**
 * Message Validation Guard — prevents "空头" (empty-content) messages
 * from entering the persistence layer.
 *
 * CTO-008-P §4: DeepSeek reasoning_content is the model's chain-of-thought.
 * When the model returns reasoning_content but empty content and no tool_calls,
 * persisting this as a standalone assistant message corrupts the conversation
 * history (subsequent turns see an empty assistant message).
 *
 * Guard rules:
 * 1. Assistant messages MUST have non-empty content OR non-empty tool_calls
 * 2. reasoning_content is preserved intact during compression/replay
 * 3. Streaming responses must be consumed to finish_reason=stop before persistence
 */

import type { Message } from 'trimodel';

/** Reasons a message was rejected by the guard. */
export type RejectReason =
  | 'empty_assistant_message'
  | 'empty_content_and_tool_calls'
  | 'streaming_incomplete';

export interface GuardResult {
  allowed: boolean;
  reason?: RejectReason;
}

/**
 * Validate a single message before persistence.
 * Returns { allowed: true } if the message is safe to store.
 */
export function validateMessage(msg: Message): GuardResult {
  // Only validate assistant messages — user/system messages are always allowed
  if (msg.role !== 'assistant') {
    return { allowed: true };
  }

  const hasContent = typeof msg.content === 'string' && msg.content.trim().length > 0;
  const hasToolCalls = Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0;

  if (!hasContent && !hasToolCalls) {
    return {
      allowed: false,
      reason: 'empty_assistant_message',
    };
  }

  return { allowed: true };
}

/**
 * Validate a batch of messages before persisting a conversation turn.
 * A batch is rejected if any assistant message fails validation.
 */
export function validateMessageBatch(messages: Message[]): GuardResult {
  for (const msg of messages) {
    const result = validateMessage(msg);
    if (!result.allowed) return result;
  }
  return { allowed: true };
}

/**
 * Check if a streaming response has reached terminal state.
 * Returns false if the stream was interrupted before finish_reason.
 */
export function isStreamComplete(event: { type: string; finish_reason?: string }): boolean {
  return event.type === 'message_stop' && event.finish_reason === 'stop';
}

/**
 * Sanitize a message for persistence — strips internal fields
 * but preserves reasoning_content for future replay.
 */
export function sanitizeForPersistence(msg: Message): Message {
  const clean: Message = {
    role: msg.role,
    content: msg.content,
  };

  // Preserve reasoning_content if present (DeepSeek CoT)
  if ((msg as any).reasoning_content) {
    (clean as any).reasoning_content = (msg as any).reasoning_content;
  }

  // Preserve tool_calls if present
  if (Array.isArray((msg as any).tool_calls)) {
    (clean as any).tool_calls = (msg as any).tool_calls;
  }

  return clean;
}

/**
 * Compress a message for context window — may truncate content
 * but MUST preserve reasoning_content intact.
 */
export function compressMessage(msg: Message, maxContentLength: number): Message {
  const compressed: Message = { ...msg };

  if (typeof msg.content === 'string' && msg.content.length > maxContentLength) {
    compressed.content = msg.content.slice(0, maxContentLength) + '\u2026[truncated]';
  }

  // NEVER truncate reasoning_content — it breaks replay fidelity
  return compressed;
}
