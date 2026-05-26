import { randomUUID } from 'node:crypto';

type DbClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows?: any[]; rowCount?: number }>;
};

function requireDbClient(dbClient: DbClient | undefined): DbClient {
  if (!dbClient || typeof dbClient.query !== 'function') {
    throw new Error('dbClient.query is required');
  }
  return dbClient;
}

function normalizeLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function createSqlTimelineReplayApi({
  dbClient,
  eventsTable = 'observability_events',
  replayTable = 'observability_replays'
}: {
  dbClient: DbClient;
  eventsTable?: string;
  replayTable?: string;
}) {
  const client = requireDbClient(dbClient);

  return {
    async appendEvent(event: {
      eventId: string;
      traceId: string;
      sessionId: string;
      timestamp: string;
      source: string;
      eventType: string;
      actor: { type: string; id: string };
      status: string;
      severity: string;
      payload?: Record<string, unknown>;
      links?: Record<string, unknown>;
    }) {
      const sql = `
        INSERT INTO ${eventsTable}
        (event_id, trace_id, session_id, timestamp, source, event_type, actor_type, actor_id, status, severity, payload_json, links_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
      `;

      await client.query(sql, [
        event.eventId,
        event.traceId,
        event.sessionId,
        event.timestamp,
        event.source,
        event.eventType,
        event.actor.type,
        event.actor.id,
        event.status,
        event.severity,
        JSON.stringify(event.payload || {}),
        JSON.stringify(event.links || {})
      ]);

      return event;
    },
    async queryBySession({ sessionId, cursorEventId = null, limit = 50 }: { sessionId: string; cursorEventId?: string | null; limit?: number }) {
      const normalizedLimit = normalizeLimit(limit, 50);
      const sql = `
        SELECT event_id AS "eventId", trace_id AS "traceId", session_id AS "sessionId", timestamp, source,
               event_type AS "eventType", actor_type AS "actorType", actor_id AS "actorId", status, severity,
               payload_json AS payload, links_json AS links
        FROM ${eventsTable}
        WHERE session_id = $1 AND ($2::text IS NULL OR event_id > $2)
        ORDER BY timestamp ASC, event_id ASC
        LIMIT $3
      `;

      const result = await client.query(sql, [sessionId, cursorEventId, normalizedLimit]);
      const items = (result.rows || []).map((row) => ({
        schemaVersion: 'v1',
        eventId: row.eventId,
        traceId: row.traceId,
        sessionId: row.sessionId,
        timestamp: row.timestamp,
        source: row.source,
        eventType: row.eventType,
        actor: { type: row.actorType, id: row.actorId },
        status: row.status,
        severity: row.severity,
        payload: row.payload || {},
        links: row.links || {}
      }));

      const nextCursor = items.length === normalizedLimit ? items.at(-1)?.eventId || null : null;
      return { items, pageInfo: { limit: normalizedLimit, nextCursor, total: result.rowCount ?? items.length } };
    },
    async startReplay({ sessionId = null, traceId = null, requestedBy = 'trimc.main' } = {}) {
      if (!sessionId && !traceId) throw new Error('sessionId or traceId is required');
      const replayId = `replay_${randomUUID()}`;
      const startedAt = new Date().toISOString();

      const sql = `
        INSERT INTO ${replayTable}
        (replay_id, session_id, trace_id, status, started_at, stopped_at, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `;
      await client.query(sql, [replayId, sessionId, traceId, 'working', startedAt, null, requestedBy]);
      return { replayId, sessionId, traceId, status: 'working', startedAt, stoppedAt: null, requestedBy };
    }
  };
}