import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSqlBenchmarkSummary,
  buildSqlBenchmarkSummaryMarkdown
} from '../src/observability/benchmarkSummary.js';

const baseReport = {
  generatedAt: '2026-03-01T00:00:00.000Z',
  traceId: 'trc_1',
  concurrency: 8,
  pages: 5,
  pageSize: 20,
  queryMs: { p50: 1, p95: 2, max: 3 },
  consistency: { uniqueEventsSeen: 100, duplicateCount: 0, orderViolations: 0, emptyPages: 0 }
};

test('summary renders PASS', () => {
  const text = buildSqlBenchmarkSummary({
    ...baseReport,
    evaluation: { passed: true, failures: [] }
  });

  assert.match(text, /SQL Acceptance: PASS/);
  assert.match(text, /query p50\/p95\/max/);
});

test('summary renders FAIL and failures', () => {
  const text = buildSqlBenchmarkSummary({
    ...baseReport,
    evaluation: { passed: false, failures: ['p95 too high'] }
  });

  assert.match(text, /SQL Acceptance: FAIL/);
  assert.match(text, /p95 too high/);
});

test('markdown summary renders status and failures list', () => {
  const text = buildSqlBenchmarkSummaryMarkdown({
    ...baseReport,
    evaluation: { passed: false, failures: ['duplicate found'] }
  });

  assert.match(text, /# SQL Acceptance Summary/);
  assert.match(text, /Status: \*\*FAIL\*\*/);
  assert.match(text, /- duplicate found/);
});
