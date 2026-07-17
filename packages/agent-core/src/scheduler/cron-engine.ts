/**
 * Cron engine — schedule parsing and next-run calculation.
 * Absorbed from openclaw cron/schedule.ts, stripped of openclaw-specific
 * delivery/session concepts.
 */

import { Cron } from "croner";
import type { CronSchedule } from "./types.js";
import { resolveDefaultCronStagger, DEFAULT_STAGGER_MS } from "./stagger.js";

// ── croner cache ─────────────────────────────────────────────────
// croner instances are expensive to construct, so we cache up to 512.

const CRONER_CACHE_MAX = 512;
const cronerCache = new Map<string, Cron>();

function cronerCacheKey(cron: string, timezone?: string): string {
  return `${cron}|${timezone ?? ""}`;
}

function getCachedCroner(cron: string, timezone?: string): Cron {
  const key = cronerCacheKey(cron, timezone);
  let instance = cronerCache.get(key);
  if (!instance) {
    instance = new Cron(cron, { timezone });
    if (cronerCache.size >= CRONER_CACHE_MAX) {
      const first = cronerCache.keys().next();
      if (!first.done) cronerCache.delete(first.value);
    }
    cronerCache.set(key, instance);
  }
  return instance;
}

// ── timezone resolution ──────────────────────────────────────────

function resolveTimezone(timezone?: string): string | undefined {
  if (!timezone || timezone === "local") return undefined; // croner default = local
  return timezone;
}

// ── next-run computation ─────────────────────────────────────────

/**
 * Compute the next run timestamp (ms) for a schedule after `afterMs`.
 * Returns null if the schedule will never fire again.
 */
export function computeNextRunAtMs(
  schedule: CronSchedule,
  afterMs: number,
  staggerMs?: number,
): number | null {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs > afterMs ? schedule.atMs : null;

    case "every":
      // Align to multiples from epoch for stability
      if (afterMs <= 0) return Date.now() + schedule.everyMs;
      return afterMs + schedule.everyMs;

    case "cron": {
      const tz = resolveTimezone(schedule.timezone);
      const croner = getCachedCroner(schedule.cron, tz);
      const next = croner.nextRun(new Date(afterMs + 1));
      if (!next) return null;

      let nextMs = next.getTime();

      // ── croner year-rollback bug workaround (absorbed from openclaw) ──
      // croner v2.x has a known issue where certain cron expressions can return
      // dates in the past when year boundaries are crossed.  We detect this by
      // checking if the returned timestamp is <= afterMs and, if so, step forward
      // by one year before re-querying croner.
      if (nextMs <= afterMs) {
        const bumped = new Date(afterMs + 1);
        bumped.setFullYear(bumped.getFullYear() + 1);
        const retry = croner.nextRun(bumped);
        if (retry) {
          const retryMs = retry.getTime();
          if (retryMs > afterMs) nextMs = retryMs;
        }
      }

      // Apply stagger for top-of-hour cron jobs
      const resolvedStagger =
        staggerMs !== undefined ? staggerMs : resolveDefaultCronStagger(schedule.cron);
      if (resolvedStagger > 0 && !isStaggerDisabled(schedule.cron)) {
        nextMs += resolvedStagger;
      }

      return nextMs;
    }

    default:
      return null;
  }
}

/**
 * Compute the previous run timestamp (ms) for a schedule before `beforeMs`.
 */
export function computePreviousRunAtMs(
  schedule: CronSchedule,
  beforeMs: number,
): number | null {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs < beforeMs ? schedule.atMs : null;

    case "every": {
      const now = Date.now();
      if (now < schedule.everyMs) return null;
      // Aligned to multiples from epoch
      return now - (now % schedule.everyMs);
    }

    case "cron": {
      const tz = resolveTimezone(schedule.timezone);
      const croner = getCachedCroner(schedule.cron, tz);
      const prevs = croner.previousRuns(1, new Date(beforeMs - 1));
      const prev = prevs[0] ?? null;
      return prev ? prev.getTime() : null;
    }

    default:
      return null;
  }
}

/**
 * Validate a cron expression. Returns null on success, error message on failure.
 */
export function validateCronExpression(cron: string): string | null {
  try {
    const instance = new Cron(cron);
    // Trigger evaluation to catch hidden parse errors
    instance.nextRun();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── stagger helpers ──────────────────────────────────────────────

/**
 * Very high-frequency cron schedules (every minute or faster) should not
 * get staggered, even if they match a top-of-hour pattern.
 * Only matches patterns like "* * * * *" or "*\/2 * * * *" (sub-minute via step).
 */
const HIGH_FREQUENCY_CRON_RE = new RegExp("^\\*(?:\\/\\d+)?\\s+\\*");

function isStaggerDisabled(cron: string): boolean {
  return HIGH_FREQUENCY_CRON_RE.test(cron);
}

// ── convenience ──────────────────────────────────────────────────

/**
 * Compute initial nextRunAtMs for a newly-created job.
 */
export function computeInitialNextRunAtMs(
  schedule: CronSchedule,
  staggerMs?: number,
): number | null {
  return computeNextRunAtMs(schedule, Date.now(), staggerMs);
}

/**
 * Coerce a schedule to a safe finite number, defaulting to DEFAULT_STAGGER_MS.
 * Absorbed from openclaw coerceFiniteScheduleNumber.
 */
export function coerceFiniteScheduleNumber(
  value: unknown,
  fallback: number = DEFAULT_STAGGER_MS,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

/** Clear the croner instance cache (useful in tests). */
export function clearCronerCache(): void {
  cronerCache.clear();
}
