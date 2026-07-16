/**
 * TriMC Scheduler — public API barrel.
 */

export type {
  CronSchedule,
  CronJobState,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronStoreFile,
} from "./types.js";

export {
  newCronJobState,
  CRON_STORE_SCHEMA,
  CRON_STORE_VERSION,
} from "./types.js";

export {
  computeNextRunAtMs,
  computePreviousRunAtMs,
  computeInitialNextRunAtMs,
  validateCronExpression,
  coerceFiniteScheduleNumber,
  clearCronerCache,
} from "./cron-engine.js";

export {
  resolveJobStaggerMs,
  resolveDefaultCronStagger,
  DEFAULT_STAGGER_MS,
} from "./stagger.js";

export {
  loadJobStore,
  saveJobStore,
  invalidateJobStoreCache,
  overrideConfigDir,
  resetConfigDir,
  buildJob,
  applyJobPatch,
  patchJobState,
} from "./job-store.js";

export { JobExecutor } from "./job-executor.js";
export type { JobHandler, JobExecutorOptions } from "./job-executor.js";

export {
  computeBackoff,
  sleepWithAbort,
  withRetry,
  DEFAULT_BACKOFF_POLICY,
  FAST_RETRY_POLICY,
} from "./backoff.js";
export type { BackoffPolicy } from "./backoff.js";

export {
  evaluateHeartbeat,
  stripHeartbeatSummary,
} from "./heartbeat-policy.js";
export type {
  HeartbeatResult,
  HeartbeatPolicyOptions,
} from "./heartbeat-policy.js";
