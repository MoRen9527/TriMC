import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAuditEvent } from '../src/observability/mapper.js';

test('maps tool.call.requested to tool.call.started', () => {
  const out = mapAuditEvent({
    type: 'tool.call.requested',
    source: 'localbus',
    traceId: 'trc_1',
    sessionId: 'ses_1'
  });

  assert.equal(out.eventType, 'tool.call.started');
  assert.equal(out.status, 'working');
  assert.equal(out.source, 'localbus');
  assert.equal(out.schemaVersion, 'v1');
});

test('maps tool.call.failed to tool.call.finished with failed status', () => {
  const out = mapAuditEvent({
    type: 'tool.call.failed',
    source: 'serverbus',
    traceId: 'trc_2',
    sessionId: 'ses_2'
  });

  assert.equal(out.eventType, 'tool.call.finished');
  assert.equal(out.status, 'failed');
  assert.equal(out.severity, 'error');
});

test('maps unknown event type to error envelope', () => {
  const out = mapAuditEvent({
    type: 'unknown.event',
    source: 'gateway',
    traceId: 'trc_3',
    sessionId: 'ses_3'
  });

  assert.equal(out.eventType, 'error');
  assert.equal(out.status, 'failed');
  assert.equal(
    (out.payload.mapping as { unknownRawType?: string }).unknownRawType,
    'unknown.event'
  );
});

test('maps subagent.complete to subagent.finished done', () => {
  const out = mapAuditEvent({
    type: 'subagent.complete',
    source: 'serverbus',
    traceId: 'trc_4',
    sessionId: 'ses_4'
  });

  assert.equal(out.eventType, 'subagent.finished');
  assert.equal(out.status, 'done');
});

test('maps replay.started to replay.state.changed working', () => {
  const out = mapAuditEvent({
    type: 'replay.started',
    source: 'eventstore',
    traceId: 'trc_5',
    sessionId: 'ses_5'
  });

  assert.equal(out.eventType, 'replay.state.changed');
  assert.equal(out.status, 'working');
  assert.equal(out.source, 'eventstore');
});

test('maps message.stream.final to message.final done', () => {
  const out = mapAuditEvent({
    type: 'message.stream.final',
    source: 'gateway',
    traceId: 'trc_6',
    sessionId: 'ses_6'
  });

  assert.equal(out.eventType, 'message.final');
  assert.equal(out.status, 'done');
});
