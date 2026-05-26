-- TriMC observability baseline schema for timeline and replay APIs
-- Run with: psql "$TRIMC_DATABASE_URL" -f sql/init_observability_tables.sql

CREATE TABLE IF NOT EXISTS observability_events (
  event_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  links_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS observability_replays (
  replay_id TEXT PRIMARY KEY,
  session_id TEXT,
  trace_id TEXT,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  requested_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (session_id IS NOT NULL OR trace_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_observability_events_session_timeline
  ON observability_events (session_id, timestamp, event_id);

CREATE INDEX IF NOT EXISTS idx_observability_events_trace_timeline
  ON observability_events (trace_id, timestamp, event_id);

CREATE INDEX IF NOT EXISTS idx_observability_replays_status_updated
  ON observability_replays (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_observability_events_payload_gin
  ON observability_events USING GIN (payload_json jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_observability_events_links_gin
  ON observability_events USING GIN (links_json jsonb_path_ops);
