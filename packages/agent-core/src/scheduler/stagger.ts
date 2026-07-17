/**
 * Stagger logic absorbed from openclaw cron/stagger.ts.
 *
 * Detects top-of-hour cron schedules and assigns a per-job deterministic stagger
 * to avoid resource spikes at :00 / :01 across multiple jobs.
 */

import type { CronJob } from "./types.js";

const TOP_OF_HOUR_CRON_RE = /^\d{1,2}(,\d{1,2})*\s+\*|^(\d{1,2}\s+){2}\*/;

const TOP_OF_MINUTE_CRON_RE = /^(?:0|[1-5]?\d)\s+(?:0|[1-5]?\d)\s+\*/;

/** Default stagger for top-of-hour cron jobs (5 minutes). */
export const DEFAULT_STAGGER_MS = 5 * 60 * 1000;

/**
 * Returns true when the cron expression fires at the top of an hour
 * (second 0, minute 0) — the classic "thundering herd" pattern.
 */
function isTopOfHourCron(cron: string): boolean {
  return TOP_OF_HOUR_CRON_RE.test(cron);
}

/**
 * Heuristic: does this cron expression fire more than once per hour?
 * Used to avoid applying a large stagger to high-frequency jobs.
 */
function isSubHourlyCron(cron: string): boolean {
  return TOP_OF_MINUTE_CRON_RE.test(cron);
}

/**
 * Resolve the stagger for a given job.
 * Only top-of-hour cron jobs get staggered; others get 0.
 */
export function resolveJobStaggerMs(job: CronJob): number {
  if (job.schedule.kind !== "cron") return 0;
  if (job.staggerMs > 0) return job.staggerMs; // explicit override
  return resolveDefaultCronStagger(job.schedule.cron);
}

/**
 * Resolve the default stagger for a cron expression.
 * Top-of-hour → DEFAULT_STAGGER_MS, sub-hourly → 0, otherwise → 0.
 */
export function resolveDefaultCronStagger(cron: string): number {
  if (!isTopOfHourCron(cron)) return 0;
  if (isSubHourlyCron(cron)) return 0;
  return DEFAULT_STAGGER_MS;
}
