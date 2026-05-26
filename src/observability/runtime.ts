import { createPostgresPool } from './postgresClient.js';
import { createSqlTimelineReplayApi } from './timelineReplaySqlStores.js';

export async function createTimelineReplaySqlApiFromEnv() {
  const pool = await createPostgresPool();
  const dbClient = {
    query: (sql: string, values?: unknown[]) => pool.query(sql, values)
  };

  const api = createSqlTimelineReplayApi({
    dbClient,
    eventsTable: process.env.TRIMC_EVENTS_TABLE || 'observability_events',
    replayTable: process.env.TRIMC_REPLAY_TABLE || 'observability_replays'
  });

  return {
    api,
    pool,
    close: async () => {
      await pool.end();
    }
  };
}