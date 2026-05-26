import { randomUUID } from 'node:crypto';
import type { NormalizedAuditEvent } from './mapper.js';

export type TimelineBySessionQuery = {
  sessionId: string;
  cursorEventId?: string | null;
  limit?: number;
};

export type TimelineByTraceQuery = {
  traceId: string;
  page?: number;
  pageSize?: number;
};

export type ReplayState = {
  replayId: string;
  sessionId: string | null;
  traceId: string | null;
  status: 'working' | 'done';
  startedAt: string;
  stoppedAt: string | null;
  requestedBy: string;
};

export type StartReplayParams = {
  sessionId?: string | null;
  traceId?: string | null;
  requestedBy?: string;
};

function eventSort(a: NormalizedAuditEvent, b: NormalizedAuditEvent): number {
  const t = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
  if (t !== 0) return t;
  return String(a.eventId || '').localeCompare(String(b.eventId || ''));
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function validateEvent(event: NormalizedAuditEvent): void {
  if (!event.eventId) throw new Error('event.eventId is required');
  if (!event.timestamp) throw new Error('event.timestamp is required');
  if (!event.sessionId) throw new Error('event.sessionId is required');
  if (!event.traceId) throw new Error('event.traceId is required');
}

export function createInMemoryEventStore(initialEvents: NormalizedAuditEvent[] = []) {
  const events: NormalizedAuditEvent[] = [];

  function append(event: NormalizedAuditEvent): NormalizedAuditEvent {
    validateEvent(event);
    events.push(event);
    events.sort(eventSort);
    return event;
  }

  function bulkAppend(list: NormalizedAuditEvent[]): number {
    for (const event of list) {
      validateEvent(event);
      events.push(event);
    }
    events.sort(eventSort);
    return events.length;
  }

  function queryBySession(params: TimelineBySessionQuery) {
    const { sessionId, cursorEventId = null, limit = 50 } = params;
    const normalizedLimit = toPositiveInt(limit, 50);
    const scoped = events.filter((item) => item.sessionId === sessionId);

    let startIndex = 0;
    if (cursorEventId) {
      const index = scoped.findIndex((item) => item.eventId === cursorEventId);
      startIndex = index >= 0 ? index + 1 : 0;
    }

    const page = scoped.slice(startIndex, startIndex + normalizedLimit);
    const nextCursor = page.length === normalizedLimit ? page.at(-1)?.eventId || null : null;

    return {
      items: page,
      pageInfo: {
        limit: normalizedLimit,
        nextCursor,
        total: scoped.length
      }
    };
  }

  function queryByTrace(params: TimelineByTraceQuery) {
    const { traceId, page = 1, pageSize = 20 } = params;
    const normalizedPage = toPositiveInt(page, 1);
    const normalizedPageSize = toPositiveInt(pageSize, 20);
    const scoped = events.filter((item) => item.traceId === traceId);
    const start = (normalizedPage - 1) * normalizedPageSize;
    const items = scoped.slice(start, start + normalizedPageSize);

    return {
      items,
      pageInfo: {
        page: normalizedPage,
        pageSize: normalizedPageSize,
        total: scoped.length,
        totalPages: Math.ceil(scoped.length / normalizedPageSize)
      }
    };
  }

  bulkAppend(initialEvents);

  return {
    append,
    bulkAppend,
    queryBySession,
    queryByTrace
  };
}

export function createInMemoryReplayStore() {
  const replayStates = new Map<string, ReplayState>();

  return {
    save(state: ReplayState): ReplayState {
      replayStates.set(state.replayId, state);
      return state;
    },
    get(replayId: string): ReplayState | null {
      return replayStates.get(replayId) || null;
    },
    update(replayId: string, patch: Partial<ReplayState>): ReplayState | null {
      const current = replayStates.get(replayId);
      if (!current) return null;
      const next = { ...current, ...patch };
      replayStates.set(replayId, next);
      return next;
    }
  };
}

export function createTimelineReplayApi(initialEvents: NormalizedAuditEvent[] = []) {
  const eventStore = createInMemoryEventStore(initialEvents);
  const replayStore = createInMemoryReplayStore();

  return {
    ingest(event: NormalizedAuditEvent) {
      return eventStore.append(event);
    },
    bulkIngest(list: NormalizedAuditEvent[]) {
      return eventStore.bulkAppend(list);
    },
    queryTimelineBySession(params: TimelineBySessionQuery) {
      return eventStore.queryBySession(params);
    },
    queryTimelineByTrace(params: TimelineByTraceQuery) {
      return eventStore.queryByTrace(params);
    },
    startReplay({ sessionId = null, traceId = null, requestedBy = 'trimc.main' }: StartReplayParams = {}): ReplayState {
      if (!sessionId && !traceId) {
        throw new Error('sessionId or traceId is required');
      }

      const replayId = `replay_${randomUUID()}`;
      const state: ReplayState = {
        replayId,
        sessionId,
        traceId,
        status: 'working',
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        requestedBy
      };

      return replayStore.save(state);
    },
    stopReplay({ replayId }: { replayId: string }): ReplayState {
      const state = replayStore.get(replayId);
      if (!state) throw new Error('replay not found');
      if (state.status === 'done') return state;
      return replayStore.update(replayId, {
        status: 'done',
        stoppedAt: new Date().toISOString()
      }) as ReplayState;
    },
    getReplay({ replayId }: { replayId: string }): ReplayState | null {
      return replayStore.get(replayId);
    }
  };
}