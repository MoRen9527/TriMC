/**
 * Backoff utilities — absorbed from openclaw infra/backoff.ts.
 *
 * Supports fixed, exponential, and jittered backoff strategies
 * for cron job retry and other TriMC internal operations.
 */

export interface BackoffPolicy {
  /** Initial delay in ms. */
  initialMs: number;
  /** Maximum delay cap in ms. */
  maxMs: number;
  /** Multiplication factor per attempt (e.g. 2 = exponential). */
  factor: number;
  /** Jitter fraction (0–1). 0.1 = ±10% random jitter. */
  jitter: number;
}

/** Sensible defaults used by openclaw. */
export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.1,
};

/** Fast-retry policy for transient errors (e.g. network flakes). */
export const FAST_RETRY_POLICY: BackoffPolicy = {
  initialMs: 500,
  maxMs: 10_000,
  factor: 1.5,
  jitter: 0.2,
};

/**
 * Compute the backoff delay for a given attempt number (1-indexed).
 *
 * Formula: min(maxMs, round(initialMs * factor^(attempt-1) * (1 + jitter * random)))
 */
export function computeBackoff(
  policy: BackoffPolicy,
  attempt: number,
): number {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitterAmount = base * policy.jitter * (Math.random() * 2 - 1); // ±jitter
  return Math.min(policy.maxMs, Math.round(base + jitterAmount));
}

/**
 * Sleep for `ms` milliseconds, with optional AbortSignal support.
 * Returns early if the signal is aborted.
 */
export async function sleepWithAbort(
  ms: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return;

  if (abortSignal?.aborted) {
    throw new Error("aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (abortSignal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Execute an async function with retry logic.
 *
 * On failure, waits for the computed backoff delay and retries up to
 * `maxAttempts` times.  Returns the result on first success.
 * Throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    policy?: BackoffPolicy;
    signal?: AbortSignal;
    onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const policy = options.policy ?? DEFAULT_BACKOFF_POLICY;
  const signal = options.signal;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (signal?.aborted) throw new Error("aborted");
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= maxAttempts) break;

      const delayMs = computeBackoff(policy, attempt);
      options.onRetry?.(attempt, lastError, delayMs);

      try {
        await sleepWithAbort(delayMs, signal);
      } catch {
        throw lastError;
      }
    }
  }

  throw lastError!;
}
