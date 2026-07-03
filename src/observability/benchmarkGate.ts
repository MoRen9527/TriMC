import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function resolveBenchmarkThresholds(env = process.env) {
  return {
    maxP95Ms: toNumber(env.CORE_AGENT_BENCH_MAX_P95_MS, null),
    maxOrderViolations: toNumber(env.CORE_AGENT_BENCH_MAX_ORDER_VIOLATIONS, 0),
    maxDuplicateCount: toNumber(env.CORE_AGENT_BENCH_MAX_DUPLICATE_COUNT, null)
  };
}

export function evaluateBenchmarkReport(report, thresholds) {
  const failures = [];

  if (thresholds.maxP95Ms !== null && report.queryMs.p95 > thresholds.maxP95Ms) {
    failures.push(`p95 ${report.queryMs.p95}ms exceeds threshold ${thresholds.maxP95Ms}ms`);
  }

  if (report.consistency.orderViolations > thresholds.maxOrderViolations) {
    failures.push(
      `orderViolations ${report.consistency.orderViolations} exceeds threshold ${thresholds.maxOrderViolations}`
    );
  }

  if (
    thresholds.maxDuplicateCount !== null &&
    report.consistency.duplicateCount > thresholds.maxDuplicateCount
  ) {
    failures.push(
      `duplicateCount ${report.consistency.duplicateCount} exceeds threshold ${thresholds.maxDuplicateCount}`
    );
  }

  return {
    passed: failures.length === 0,
    failures
  };
}

export function writeBenchmarkReport(report, outputPath) {
  const absolute = resolve(outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return absolute;
}
