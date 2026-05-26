import { randomUUID } from 'node:crypto';

export type AuditActor = {
  type: string;
  id: string;
};

export type RawAuditEvent = {
  type?: string;
  eventType?: string;
  eventId?: string;
  traceId?: string;
  sessionId?: string;
  timestamp?: string;
  source?: string;
  actor?: Partial<AuditActor>;
  payload?: Record<string, unknown>;
  severity?: string;
  status?: string;
  parentEventId?: string | null;
  relatedToolCallId?: string | null;
  links?: {
    parentEventId?: string | null;
    relatedToolCallId?: string | null;
  };
};

export type NormalizedAuditEvent = {
  schemaVersion: 'v1';
  eventId: string;
  traceId: string;
  sessionId: string;
  timestamp: string;
  source: string;
  eventType: string;
  actor: AuditActor;
  status: string;
  severity: string;
  payload: Record<string, unknown>;
  links: {
    parentEventId: string | null;
    relatedToolCallId: string | null;
  };
};

const EVENT_TYPE_MAP: Record<string, { eventType: string; status: string; severity?: string }> = {
  'session.opened': { eventType: 'session.state.changed', status: 'working' },
  'session.closed': { eventType: 'session.state.changed', status: 'done' },
  'message.stream.chunk': { eventType: 'message.chunk', status: 'working' },
  'message.stream.final': { eventType: 'message.final', status: 'done' },
  'tool.call.requested': { eventType: 'tool.call.started', status: 'working' },
  'tool.call.succeeded': { eventType: 'tool.call.finished', status: 'done' },
  'tool.call.failed': { eventType: 'tool.call.finished', status: 'failed', severity: 'error' },
  'approval.request.created': { eventType: 'approval.requested', status: 'waiting' },
  'approval.request.resolved': { eventType: 'approval.resolved', status: 'done' },
  'subagent.spawn': { eventType: 'subagent.spawned', status: 'working' },
  'subagent.complete': { eventType: 'subagent.finished', status: 'done' },
  'subagent.error': { eventType: 'subagent.finished', status: 'failed', severity: 'error' },
  'replay.started': { eventType: 'replay.state.changed', status: 'working' },
  'replay.finished': { eventType: 'replay.state.changed', status: 'done' }
};

function normalizeSource(rawSource: string | undefined): string {
  const source = String(rawSource || '').toLowerCase();
  if (source.includes('gateway')) return 'gateway';
  if (source.includes('server')) return 'serverbus';
  if (source.includes('local')) return 'localbus';
  if (source.includes('eventstore')) return 'eventstore';
  return 'gateway';
}

function normalizeActor(actor?: Partial<AuditActor>): AuditActor {
  if (!actor) {
    return { type: 'system', id: 'trimc.main' };
  }

  return {
    type: actor.type || 'system',
    id: actor.id || 'trimc.main'
  };
}

export function mapAuditEvent(raw: RawAuditEvent): NormalizedAuditEvent {
  if (!raw || typeof raw !== 'object') {
    throw new Error('raw audit event is required');
  }

  const rawType = raw.type || raw.eventType;
  if (!rawType) {
    throw new Error('raw event type is required');
  }

  const mapped = EVENT_TYPE_MAP[rawType] || {
    eventType: 'error',
    status: 'failed',
    severity: 'error'
  };

  const eventId = raw.eventId || `evt_${randomUUID()}`;
  const timestamp = raw.timestamp || new Date().toISOString();
  const payload = raw.payload || {};
  const mappedPayload = EVENT_TYPE_MAP[rawType]
    ? payload
    : {
        ...payload,
        mapping: {
          unknownRawType: rawType
        }
      };

  return {
    schemaVersion: 'v1',
    eventId,
    traceId: raw.traceId || 'trc_unknown',
    sessionId: raw.sessionId || 'ses_unknown',
    timestamp,
    source: normalizeSource(raw.source),
    eventType: mapped.eventType,
    actor: normalizeActor(raw.actor),
    status: mapped.status || raw.status || 'working',
    severity: mapped.severity || raw.severity || 'info',
    payload: mappedPayload,
    links: {
      parentEventId: raw.parentEventId || raw.links?.parentEventId || null,
      relatedToolCallId: raw.relatedToolCallId || raw.links?.relatedToolCallId || null
    }
  };
}