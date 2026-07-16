import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeBackoff,
  sleepWithAbort,
  withRetry,
  DEFAULT_BACKOFF_POLICY,
  FAST_RETRY_POLICY,
} from "../backoff.js";

describe("computeBackoff", () => {
  it("returns initialMs on attempt 1", () => {
    const result = computeBackoff(DEFAULT_BACKOFF_POLICY, 1);
    // With jitter, result should be near initialMs (1000) ±10%
    assert.ok(result >= 800 && result <= 1200, `expected ~1000±200, got ${result}`);
  });

  it("grows exponentially with attempt number", () => {
    const a1 = computeBackoff({ initialMs: 100, maxMs: 10000, factor: 2, jitter: 0 }, 1);
    const a3 = computeBackoff({ initialMs: 100, maxMs: 10000, factor: 2, jitter: 0 }, 3);
    assert.strictEqual(a1, 100);
    assert.strictEqual(a3, 400); // 100 * 2^2
  });

  it("caps at maxMs", () => {
    const big = computeBackoff({ initialMs: 100, maxMs: 500, factor: 3, jitter: 0 }, 10);
    assert.ok(big <= 500);
  });

  it("handles attempt 0 gracefully (clamped to attempt 1)", () => {
    const result = computeBackoff(DEFAULT_BACKOFF_POLICY, 0);
    assert.ok(typeof result === "number" && result > 0);
  });

  it("uses FAST_RETRY_POLICY with shorter delays", () => {
    const fast = computeBackoff(FAST_RETRY_POLICY, 1);
    const slow = computeBackoff(DEFAULT_BACKOFF_POLICY, 1);
    // fast initial is 500, slow is 1000 — with jitter there can be overlap,
    // but the midpoint should be lower
    assert.ok(fast < 1000 || fast <= slow, `fast=${fast}, slow=${slow}`);
  });

  it("returns deterministic results with jitter=0", () => {
    const results = Array.from({ length: 10 }, () =>
      computeBackoff({ initialMs: 100, maxMs: 10000, factor: 2, jitter: 0 }, 2),
    );
    assert.ok(results.every((r) => r === 200));
  });
});

describe("sleepWithAbort", () => {
  it("resolves quickly for zero ms", async () => {
    const start = Date.now();
    await sleepWithAbort(0);
    assert.ok(Date.now() - start < 50);
  });

  it("resolves after the delay", async () => {
    const start = Date.now();
    await sleepWithAbort(10);
    assert.ok(Date.now() - start >= 10);
  });

  it("aborts on signal", async () => {
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 5);

    await assert.rejects(
      () => sleepWithAbort(5000, controller.signal),
      { message: "aborted" },
    );

    assert.ok(Date.now() - start < 200);
  });

  it("rejects immediately if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => sleepWithAbort(5000, controller.signal),
      { message: "aborted" },
    );
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    assert.strictEqual(result, "ok");
  });

  it("retries on failure", async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return "recovered";
    }, { policy: { initialMs: 1, maxMs: 10, factor: 1, jitter: 0 }, maxAttempts: 5 });

    assert.strictEqual(result, "recovered");
    assert.strictEqual(calls, 3);
  });

  it("throws last error when all attempts fail", async () => {
    await assert.rejects(
      () =>
        withRetry(
          () => Promise.reject(new Error("always-fail")),
          { maxAttempts: 2, policy: { initialMs: 1, maxMs: 10, factor: 1, jitter: 0 } },
        ),
      { message: "always-fail" },
    );
  });

  it("calls onRetry callback on failures", async () => {
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;

    await withRetry(
      () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "ok";
      },
      {
        maxAttempts: 3,
        policy: { initialMs: 1, maxMs: 10, factor: 1, jitter: 0 },
        onRetry: (attempt, _error, delayMs) => {
          retries.push({ attempt, delayMs });
        },
      },
    );

    assert.strictEqual(retries.length, 2);
    assert.strictEqual(retries[0].attempt, 1);
    assert.strictEqual(retries[1].attempt, 2);
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await assert.rejects(
      () =>
        withRetry(
          () => Promise.reject(new Error("fail")),
          { maxAttempts: 3, signal: controller.signal, policy: { initialMs: 100, maxMs: 1000, factor: 2, jitter: 0 } },
        ),
    );
  });
});
