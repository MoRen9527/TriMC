/**
 * Heartbeat Policy — determines whether a cron job execution result
 * warrants a notification/delivery or can be silently skipped.
 *
 * TriMC-specific (not directly absorbed from openclaw, which ties
 * heartbeat to channel delivery).  The openclaw pattern is adapted
 * to TriMC's agent-loop context.
 */

export interface HeartbeatResult {
  /** Overall status of the heartbeat check. */
  status: "ok" | "stale" | "error" | "skipped";
  /** Human-readable summary (max 200 chars). */
  summary: string;
  /** When true, the heartbeat is a pure "everything OK" and can skip delivery. */
  shouldSkipDelivery: boolean;
  /** Timestamp of the last observed activity. */
  lastActivityMs: number | null;
}

export interface HeartbeatPolicyOptions {
  /**
   * Max milliseconds since last activity before the job is considered "stale".
   * Default: 5 minutes.
   */
  staleThresholdMs?: number;
  /**
   * Maximum length of the summary string returned by the handler.
   * Default: 200.
   */
  maxSummaryChars?: number;
  /**
   * When true, consecutive "ok" heartbeats are skipped (only the first one
   * after a state change is delivered).  Default: true.
   */
  suppressConsecutiveOk?: boolean;
}

const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SUMMARY_CHARS = 200;

/**
 * Evaluate a job execution's heartbeat status.
 *
 * @param lastActivityMs - Timestamp of the last job activity (or null if never run).
 * @param errorMessage - Error message from last execution (null if last run was OK).
 * @param consecutiveErrors - Number of consecutive error runs.
 * @param previouslyOk - Whether the previous heartbeat was "ok".
 * @param options - Policy tuning options.
 */
export function evaluateHeartbeat(
  lastActivityMs: number | null,
  errorMessage: string | null,
  consecutiveErrors: number,
  previouslyOk: boolean,
  options: HeartbeatPolicyOptions = {},
): HeartbeatResult {
  const staleThresholdMs =
    options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const suppressConsecutiveOk = options.suppressConsecutiveOk ?? true;

  const now = Date.now();

  // ── no activity ever ────────────────────────────────────────────
  if (lastActivityMs === null) {
    const summary = "Job has never executed.";
    return {
      status: "stale",
      summary,
      shouldSkipDelivery: false,
      lastActivityMs: null,
    };
  }

  // ── stale detection ─────────────────────────────────────────────
  const elapsed = now - lastActivityMs;
  if (elapsed > staleThresholdMs) {
    const minutesStale = Math.round(elapsed / 60_000);
    const summary = `Last activity was ${minutesStale} min ago (threshold: ${Math.round(staleThresholdMs / 60_000)} min).`;
    return {
      status: "stale",
      summary: truncate(summary, maxSummaryChars),
      shouldSkipDelivery: false,
      lastActivityMs,
    };
  }

  // ── error state ─────────────────────────────────────────────────
  if (errorMessage !== null) {
    const summary =
      consecutiveErrors > 1
        ? `Job has ${consecutiveErrors} consecutive errors. Last: ${errorMessage}`
        : `Job error: ${errorMessage}`;
    return {
      status: "error",
      summary: truncate(summary, maxSummaryChars),
      shouldSkipDelivery: false,
      lastActivityMs,
    };
  }

  // ── ok ──────────────────────────────────────────────────────────
  const summary = `Job running normally. Last activity: ${Math.round(elapsed / 1000)}s ago.`;

  // Suppress consecutive OK heartbeats to avoid noise
  const shouldSkip = suppressConsecutiveOk && previouslyOk;

  return {
    status: shouldSkip ? "skipped" : "ok",
    summary: truncate(summary, maxSummaryChars),
    shouldSkipDelivery: shouldSkip,
    lastActivityMs,
  };
}

/**
 * Strip heartbeat-only tokens from a summary text.
 * Adapted from openclaw's stripHeartbeatToken pattern.
 *
 * Returns the text without heartbeat markers, and whether the result
 * should be skipped (i.e. it was a pure heartbeat with no content).
 */
export function stripHeartbeatSummary(
  text: string,
  maxChars: number = 200,
): { text: string; shouldSkip: boolean } {
  // Common heartbeat patterns to detect
  const heartbeatPatterns = [
    /^HEARTBEAT:\s*/i,
    /^\[HEARTBEAT\]\s*/i,
    /^heartbeat\s*[-:]\s*/i,
    /^OK\s*$/i,
  ];

  let cleaned = text.trim();

  for (const pattern of heartbeatPatterns) {
    cleaned = cleaned.replace(pattern, "").trim();
  }

  // When a heartbeat prefix was found and the remaining content is
  // generic/status-only, treat it as a pure heartbeat that should be skipped.
  const isGenericHeartbeat =
    /^(ok|alive|running|up|healthy|all good|status normal|status ok|everything (ok|fine|good))\s*$/i.test(cleaned);

  const shouldSkip =
    cleaned.length === 0 || isGenericHeartbeat;

  return {
    text: truncate(cleaned, maxChars),
    shouldSkip,
  };
}

// ── helpers ───────────────────────────────────────────────────────

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}
