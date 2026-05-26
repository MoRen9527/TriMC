import { mapAuditEvent, type NormalizedAuditEvent, type RawAuditEvent } from './mapper.js';

export const RAW_SAMPLE_EVENTS: RawAuditEvent[] = [
  {
    type: 'session.opened',
    source: 'gateway',
    traceId: 'trc_contract_01',
    sessionId: 'ses_contract_01',
    actor: { type: 'agent', id: 'agent.main' },
    payload: { scene: 'main' }
  },
  {
    type: 'tool.call.requested',
    source: 'serverbus',
    traceId: 'trc_contract_01',
    sessionId: 'ses_contract_01',
    actor: { type: 'agent', id: 'agent.main' },
    relatedToolCallId: 'tool_001',
    payload: { tool: 'read_file' }
  },
  {
    type: 'tool.call.succeeded',
    source: 'serverbus',
    traceId: 'trc_contract_01',
    sessionId: 'ses_contract_01',
    actor: { type: 'agent', id: 'agent.main' },
    relatedToolCallId: 'tool_001',
    payload: { tool: 'read_file', durationMs: 42 }
  },
  {
    type: 'approval.request.created',
    source: 'serverbus',
    traceId: 'trc_contract_02',
    sessionId: 'ses_contract_02',
    actor: { type: 'agent', id: 'agent.main' },
    payload: { requestId: 'apr_001', reason: 'sensitive_action' }
  },
  {
    type: 'approval.request.resolved',
    source: 'serverbus',
    traceId: 'trc_contract_02',
    sessionId: 'ses_contract_02',
    actor: { type: 'agent', id: 'agent.main' },
    payload: { requestId: 'apr_001', decision: 'approved' }
  },
  {
    type: 'subagent.spawn',
    source: 'localbus',
    traceId: 'trc_contract_03',
    sessionId: 'ses_contract_03',
    actor: { type: 'subagent', id: 'agent.sub.search' },
    parentEventId: 'evt_parent_spawn',
    payload: { role: 'search' }
  },
  {
    type: 'subagent.complete',
    source: 'localbus',
    traceId: 'trc_contract_03',
    sessionId: 'ses_contract_03',
    actor: { type: 'subagent', id: 'agent.sub.search' },
    parentEventId: 'evt_parent_spawn',
    payload: { role: 'search', result: 'done' }
  },
  {
    type: 'message.stream.chunk',
    source: 'gateway',
    traceId: 'trc_contract_04',
    sessionId: 'ses_contract_04',
    actor: { type: 'agent', id: 'agent.main' },
    payload: { chunk: 'hello' }
  },
  {
    type: 'message.stream.final',
    source: 'gateway',
    traceId: 'trc_contract_04',
    sessionId: 'ses_contract_04',
    actor: { type: 'agent', id: 'agent.main' },
    payload: { content: 'hello world' }
  },
  {
    type: 'replay.started',
    source: 'eventstore',
    traceId: 'trc_contract_05',
    sessionId: 'ses_contract_05',
    actor: { type: 'system', id: 'replay.worker' },
    payload: { range: 'latest-20' }
  },
  {
    type: 'replay.finished',
    source: 'eventstore',
    traceId: 'trc_contract_05',
    sessionId: 'ses_contract_05',
    actor: { type: 'system', id: 'replay.worker' },
    payload: { range: 'latest-20', count: 20 }
  },
  {
    type: 'unknown.event',
    source: 'gateway',
    traceId: 'trc_contract_06',
    sessionId: 'ses_contract_06',
    actor: { type: 'system', id: 'agent.main' },
    payload: { detail: 'for fallback validation' }
  }
];

export function buildContractSamples(): NormalizedAuditEvent[] {
  return RAW_SAMPLE_EVENTS.map((item) => mapAuditEvent(item));
}
