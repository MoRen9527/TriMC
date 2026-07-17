import { describe, it, expect } from 'vitest';
import type { Message } from 'trimodel';
import {
  validateMessage,
  validateMessageBatch,
  isStreamComplete,
  sanitizeForPersistence,
  compressMessage,
} from '../validate.js';

function msg(overrides: Partial<Message> & Record<string, unknown> = {}): Message {
  return {
    role: 'assistant',
    content: 'Hello',
    ...overrides,
  };
}

describe('validateMessage', () => {
  it('allows user messages unconditionally', () => {
    expect(validateMessage({ role: 'user', content: '' })).toEqual({ allowed: true });
  });

  it('allows system messages unconditionally', () => {
    expect(validateMessage({ role: 'system', content: '' })).toEqual({ allowed: true });
  });

  it('allows assistant message with content', () => {
    expect(validateMessage(msg({ content: 'result' }))).toEqual({ allowed: true });
  });

  it('allows assistant message with tool_calls but empty content', () => {
    expect(validateMessage(msg({
      content: '',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    }))).toEqual({ allowed: true });
  });

  it('rejects assistant message with empty content and no tool_calls', () => {
    expect(validateMessage(msg({ content: '' }))).toEqual({
      allowed: false,
      reason: 'empty_assistant_message',
    });
  });

  it('rejects assistant message with whitespace-only content', () => {
    expect(validateMessage(msg({ content: '   ' }))).toEqual({
      allowed: false,
      reason: 'empty_assistant_message',
    });
  });

  it('rejects reasoning_content-only assistant message', () => {
    const result = validateMessage(msg({ content: '', reasoning_content: 'thinking...' }));
    expect(result.allowed).toBe(false);
  });
});

describe('validateMessageBatch', () => {
  it('allows batch with all valid messages', () => {
    expect(validateMessageBatch([
      { role: 'user', content: 'hi' },
      msg({ content: 'response' }),
    ])).toEqual({ allowed: true });
  });

  it('rejects batch containing empty assistant message', () => {
    expect(validateMessageBatch([
      { role: 'user', content: 'hi' },
      msg({ content: '' }),
    ])).toEqual({ allowed: false, reason: 'empty_assistant_message' });
  });
});

describe('isStreamComplete', () => {
  it('returns true for message_stop with finish_reason=stop', () => {
    expect(isStreamComplete({ type: 'message_stop', finish_reason: 'stop' })).toBe(true);
  });

  it('returns false for message_stop with finish_reason=length', () => {
    expect(isStreamComplete({ type: 'message_stop', finish_reason: 'length' })).toBe(false);
  });

  it('returns false for content_block_delta', () => {
    expect(isStreamComplete({ type: 'content_block_delta' })).toBe(false);
  });
});

describe('sanitizeForPersistence', () => {
  it('preserves reasoning_content', () => {
    const m = msg({ reasoning_content: 'step-by-step...' }) as any;
    const clean = sanitizeForPersistence(m);
    expect((clean as any).reasoning_content).toBe('step-by-step...');
  });

  it('preserves tool_calls', () => {
    const m = msg({
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'test', arguments: '{}' } }],
    }) as any;
    const clean = sanitizeForPersistence(m);
    expect((clean as any).tool_calls).toEqual([
      { id: 't1', type: 'function', function: { name: 'test', arguments: '{}' } },
    ]);
  });
});

describe('compressMessage', () => {
  it('truncates content but preserves reasoning_content', () => {
    const m = msg({
      content: 'a'.repeat(200),
      reasoning_content: 'think...',
    }) as any;
    const compressed = compressMessage(m, 100);
    expect(typeof compressed.content).toBe('string');
    expect((compressed.content as string).length).toBe(112); // 100 chars + '…[truncated]'
    expect((compressed as any).reasoning_content).toBe('think...');
  });

  it('does not truncate short content', () => {
    const m = msg({ content: 'short' }) as any;
    const compressed = compressMessage(m, 100);
    expect(compressed.content).toBe('short');
  });
});
