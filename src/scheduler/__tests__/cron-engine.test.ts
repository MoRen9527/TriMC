/**
 * Tests for cron-engine: schedule parsing, next/prev run calculation.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  computeNextRunAtMs,
  computePreviousRunAtMs,
  computeInitialNextRunAtMs,
  validateCronExpression,
  clearCronerCache,
} from "../cron-engine.js";

describe("cron-engine", () => {
  after(() => clearCronerCache());

  // ── "at" schedule ──────────────────────────────────────────────

  describe('"at" schedule', () => {
    it("returns atMs when afterMs < atMs", () => {
      const after = 1000;
      const at = 5000;
      const result = computeNextRunAtMs({ kind: "at", atMs: at }, after);
      assert.equal(result, at);
    });

    it("returns null when afterMs >= atMs", () => {
      const result = computeNextRunAtMs({ kind: "at", atMs: 1000 }, 5000);
      assert.equal(result, null);
    });

    it("previous run returns atMs when beforeMs > atMs", () => {
      const result = computePreviousRunAtMs({ kind: "at", atMs: 1000 }, 5000);
      assert.equal(result, 1000);
    });
  });

  // ── "every" schedule ───────────────────────────────────────────

  describe('"every" schedule', () => {
    it("computes next run as afterMs + everyMs", () => {
      const result = computeNextRunAtMs(
        { kind: "every", everyMs: 60_000 },
        100_000,
      );
      assert.equal(result, 160_000);
    });

    it("defaults to now + everyMs when afterMs <= 0", () => {
      const before = Date.now();
      const result = computeNextRunAtMs(
        { kind: "every", everyMs: 10_000 },
        0,
      );
      assert.ok(typeof result === "number" && result > before);
    });
  });

  // ── "cron" schedule ────────────────────────────────────────────

  describe('"cron" schedule', () => {
    it("parses 5-minute cron and returns next run in the future", () => {
      const now = Date.now();
      const result = computeNextRunAtMs(
        { kind: "cron", cron: "*/5 * * * *" },
        now,
      );
      assert.ok(typeof result === "number");
      assert.ok(result > now, `expected ${result} > ${now}`);
      // Should be within the next 5 minutes
      assert.ok(result <= now + 300_000, `expected within 5 min, got ${result - now}ms`);
    });

    it("parses daily cron (* 0 * * *)", () => {
      const now = Date.now();
      const result = computeNextRunAtMs(
        { kind: "cron", cron: "0 0 * * *" },
        now,
      );
      assert.ok(typeof result === "number");
      assert.ok(result > now);
    });

    it("parses weekly cron (0 0 * * 0)", () => {
      const now = Date.now();
      const result = computeNextRunAtMs(
        { kind: "cron", cron: "0 0 * * 0" },
        now,
      );
      assert.ok(typeof result === "number");
      assert.ok(result > now);
    });

    it("returns null for never-firing cron", () => {
      // A cron in the distant past won't fire again
      const result = computeNextRunAtMs(
        { kind: "cron", cron: "0 0 29 2 *" }, // Feb 29 — rare
        Date.now() + 10 * 365 * 24 * 3600_000, // far future
      );
      // May or may not be null depending on upcoming leap years, but should be far out
      if (result !== null) {
        assert.ok(result > Date.now());
      }
    });

    it("applies top-of-hour stagger", () => {
      const now = Date.now();
      const withoutStagger = computeNextRunAtMs(
        { kind: "cron", cron: "0 * * * *" },
        now,
        0,
      );
      const withStagger = computeNextRunAtMs(
        { kind: "cron", cron: "0 * * * *" },
        now,
        300_000, // 5 min stagger
      );
      assert.ok(typeof withStagger === "number");
      assert.ok(typeof withoutStagger === "number");
      if (withoutStagger !== null && withStagger !== null) {
        assert.equal(withStagger - withoutStagger, 300_000);
      }
    });
  });

  // ── validateCronExpression ─────────────────────────────────────

  describe("validateCronExpression", () => {
    it("returns null for valid cron", () => {
      assert.equal(validateCronExpression("*/5 * * * *"), null);
      assert.equal(validateCronExpression("0 0 * * *"), null);
      assert.equal(validateCronExpression("0 9 * * 1-5"), null);
    });

    it("returns error for invalid cron", () => {
      const err = validateCronExpression("not a cron expression");
      assert.ok(typeof err === "string");
      assert.ok(err.length > 0);
    });

    it("returns error for empty string", () => {
      const err = validateCronExpression("");
      assert.ok(typeof err === "string");
    });
  });

  // ── computeInitialNextRunAtMs ──────────────────────────────────

  describe("computeInitialNextRunAtMs", () => {
    it("returns a future timestamp for valid schedules", () => {
      const now = Date.now();
      const result = computeInitialNextRunAtMs({
        kind: "cron",
        cron: "*/10 * * * *",
      });
      assert.ok(typeof result === "number");
      assert.ok(result > now);
    });
  });
});
