import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBenchmarkReport, resolveBenchmarkThresholds } from '../src/observability/benchmarkGate.js';

function report(overrides = {}) {
  return {
    queryMs: {
      p95: 10
    },
    consistency: {
      duplicateCount: 0,
      orderViolations: 0
    },
    ...overrides
  };
}

test('resolveBenchmarkThresholds reads env values', () => {
  const out = resolveBenchmarkThresholds({
    CORE_AGENT_BENCH_MAX_P95_MS: '25',
    CORE_AGENT_BENCH_MAX_ORDER_VIOLATIONS: '1',
    CORE_AGENT_BENCH_MAX_DUPLICATE_COUNT: '3'
  });

  assert.equal(out.maxP95Ms, 25);
  assert.equal(out.maxOrderViolations, 1);
  assert.equal(out.maxDuplicateCount, 3);
});

test('evaluateBenchmarkReport passes when under thresholds', () => {
  const result = evaluateBenchmarkReport(report(), {
    maxP95Ms: 20,
    maxOrderViolations: 0,
    maxDuplicateCount: 0
  });

  assert.equal(result.passed, true);
  assert.equal(result.failures.length, 0);
});

test('evaluateBenchmarkReport fails when above thresholds', () => {
  const result = evaluateBenchmarkReport(
    report({
      queryMs: { p95: 30 },
      consistency: { duplicateCount: 2, orderViolations: 1 }
    }),
    {
      maxP95Ms: 20,
      maxOrderViolations: 0,
      maxDuplicateCount: 1
    }
  );

  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 3);
});
