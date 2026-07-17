/**
 * TriMC Cron Scheduler — Clean types stripped of openclaw channel/delivery concepts.
 *
 * Schedule kinds:
 *   "at"    — fire once at an absolute timestamp (ms).
 *   "every" — fire every N ms (interval).
 *   "cron"  — cron expression (via croner), optional timezone.
 */

export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number }
  | { kind: "cron"; cron: string; timezone?: string };

/** Runtime state tracked per job. */
export interface CronJobState {
  nextRunAtMs: number | null;
  runningAtMs: number | null;
  lastRunAtMs: number | null;
  lastRunStatus: "ok" | "error" | null;
  lastError: string | null;
  consecutiveErrors: number;
  lastDurationMs: number | null;
  runCount: number;
}

/** A persisted cron job. */
export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: CronSchedule;
  /** Opaque payload passed to the executor callback. */
  payload: Record<string, unknown>;
  /** Top-of-hour stagger in ms (only meaningful for cron schedules). */
  staggerMs: number;
  state: CronJobState;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Input for creating a new job. */
export type CronJobCreate = Omit<
  CronJob,
  "id" | "state" | "createdAtMs" | "updatedAtMs" | "staggerMs"
> & {
  id?: string;
  staggerMs?: number;
};

/** Input for patching an existing job. */
export type CronJobPatch = Partial<
  Omit<CronJob, "id" | "state" | "createdAtMs" | "updatedAtMs">
>;

/** Default initial state for a new job. */
export function newCronJobState(): CronJobState {
  return {
    nextRunAtMs: null,
    runningAtMs: null,
    lastRunAtMs: null,
    lastRunStatus: null,
    lastError: null,
    consecutiveErrors: 0,
    lastDurationMs: null,
    runCount: 0,
  };
}

/** Disk format: a versioned map of jobs. */
export interface CronStoreFile {
  $schema: string;
  version: number;
  jobs: Record<string, CronJob>;
}

export const CRON_STORE_SCHEMA =
  "urn:trimetaverse:tri-mc:cron-store:v1";
export const CRON_STORE_VERSION = 1;
