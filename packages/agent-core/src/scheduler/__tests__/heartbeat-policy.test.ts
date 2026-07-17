import { describe, it } from "node:test";
import assert from "node:assert";
import { evaluateHeartbeat, stripHeartbeatSummary } from "../heartbeat-policy.js";

describe("evaluateHeartbeat", () => {
  const FIVE_MIN = 5 * 60 * 1000;
  const TEN_MIN = 10 * 60 * 1000;

  it("returns stale when lastActivityMs is null", () => {
    const result = evaluateHeartbeat(null, null, 0, false);
    assert.strictEqual(result.status, "stale");
    assert.ok(result.summary.includes("never executed"));
    assert.strictEqual(result.shouldSkipDelivery, false);
  });

  it("returns stale when elapsed > threshold", () => {
    const staleAt = Date.now() - TEN_MIN;
    const result = evaluateHeartbeat(staleAt, null, 0, false, { staleThresholdMs: FIVE_MIN });
    assert.strictEqual(result.status, "stale");
    assert.ok(result.summary.includes("10 min"));
    assert.strictEqual(result.shouldSkipDelivery, false);
  });

  it("returns ok for recent activity with no errors", () => {
    const recent = Date.now() - 1_000; // 1 second ago
    const result = evaluateHeartbeat(recent, null, 0, false);
    assert.strictEqual(result.status, "ok");
    assert.ok(result.summary.includes("running normally"));
    assert.strictEqual(result.shouldSkipDelivery, false);
  });

  it("skips delivery for consecutive ok when suppressConsecutiveOk is true", () => {
    const recent = Date.now() - 1_000;
    const result = evaluateHeartbeat(recent, null, 0, true);
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.shouldSkipDelivery, true);
  });

  it("does not skip when suppressConsecutiveOk is false", () => {
    const recent = Date.now() - 1_000;
    const result = evaluateHeartbeat(recent, null, 0, true, { suppressConsecutiveOk: false });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.shouldSkipDelivery, false);
  });

  it("returns error with errorMessage", () => {
    const recent = Date.now() - 1_000;
    const result = evaluateHeartbeat(recent, "ENOENT: file not found", 1, false);
    assert.strictEqual(result.status, "error");
    assert.ok(result.summary.includes("ENOENT"));
    assert.strictEqual(result.shouldSkipDelivery, false);
  });

  it("reports consecutiveErrors count", () => {
    const recent = Date.now() - 1_000;
    const result = evaluateHeartbeat(recent, "timeout", 5, false);
    assert.strictEqual(result.status, "error");
    assert.ok(result.summary.includes("5 consecutive errors"));
  });

  it("truncates long summaries", () => {
    const longError = "x".repeat(300);
    const result = evaluateHeartbeat(Date.now(), longError, 1, false, { maxSummaryChars: 50 });
    assert.ok(result.summary.length <= 50);
    assert.ok(result.summary.endsWith("..."));
  });

  it("reports stale over error when elapsed exceeds threshold (stale check first)", () => {
    const staleAt = Date.now() - TEN_MIN;
    const result = evaluateHeartbeat(staleAt, "some error", 1, false, { staleThresholdMs: FIVE_MIN });
    assert.strictEqual(result.status, "stale");
  });

  it("uses default 5-min threshold when not specified", () => {
    // Just within threshold
    const recent = Date.now() - 60_000; // 1 min ago
    const result = evaluateHeartbeat(recent, null, 0, false);
    assert.strictEqual(result.status, "ok");

    // Well past threshold
    const old = Date.now() - 10 * 60_000; // 10 min ago
    const result2 = evaluateHeartbeat(old, null, 0, false);
    assert.strictEqual(result2.status, "stale");
  });
});

describe("stripHeartbeatSummary", () => {
  it("detects HEARTBEAT: prefix", () => {
    const result = stripHeartbeatSummary("HEARTBEAT: all good");
    assert.ok(result.shouldSkip);
  });

  it("detects [HEARTBEAT] prefix", () => {
    const result = stripHeartbeatSummary("[HEARTBEAT] status normal");
    assert.ok(result.shouldSkip);
  });

  it("detects heartbeat - prefix", () => {
    const result = stripHeartbeatSummary("heartbeat - running");
    assert.ok(result.shouldSkip);
  });

  it("returns shouldSkip for pure 'OK'", () => {
    const result = stripHeartbeatSummary("OK");
    assert.ok(result.shouldSkip);
  });

  it("returns shouldSkip for pure 'alive'", () => {
    const result = stripHeartbeatSummary("alive");
    assert.ok(result.shouldSkip);
  });

  it("does not skip for actual content", () => {
    const result = stripHeartbeatSummary("Deployed version 2.5.1 to staging");
    assert.strictEqual(result.shouldSkip, false);
    assert.ok(result.text.includes("2.5.1"));
  });

  it("strips HEARTBEAT prefix but keeps remaining content if non-skip", () => {
    const result = stripHeartbeatSummary("HEARTBEAT: 3 new users registered");
    // "3 new users registered" is not a heartbeat-only message
    assert.strictEqual(result.shouldSkip, false);
    assert.ok(result.text.includes("3 new users registered"));
  });

  it("truncates long text", () => {
    const long = "x".repeat(300);
    const result = stripHeartbeatSummary(long, 50);
    assert.ok(result.text.length <= 50);
  });
});
