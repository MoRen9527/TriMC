import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSqlWeeklyIssueReport } from '../src/observability/weeklyReportTemplate.js';

const baseReport = {
  traceId: 'trc_demo',
  queryMs: { p50: 1, p95: 2, max: 3 },
  consistency: { uniqueEventsSeen: 10, duplicateCount: 0, orderViolations: 0, emptyPages: 0 },
  thresholds: { maxP95Ms: 300, maxOrderViolations: 0, maxDuplicateCount: 0 },
  evaluation: { passed: true, failures: [] }
};

test('weekly issue report renders PASS payload', () => {
  const out = buildSqlWeeklyIssueReport({
    report: baseReport,
    summaryMarkdownPath: 'summary.md',
    benchmarkJsonPath: 'bench.json',
    generatedAt: '2026-03-01T00:00:00.000Z'
  });

  assert.match(out, /\*\*PASS\*\*/);
  assert.match(out, /\[baseline\]/);
  assert.match(out, /Gate Profile: baseline/);
  assert.match(out, /Benchmark JSON: bench.json/);
  assert.match(out, /Acceptance Summary \(Markdown\): summary.md/);
});

test('weekly issue report renders failures on FAIL', () => {
  const out = buildSqlWeeklyIssueReport({
    report: {
      ...baseReport,
      thresholds: { maxP95Ms: 50, maxOrderViolations: 0, maxDuplicateCount: 0 },
      evaluation: { passed: false, failures: ['p95 over threshold'] }
    },
    summaryMarkdownPath: 'summary.md',
    benchmarkJsonPath: 'bench.json'
  });

  assert.match(out, /\*\*FAIL\*\*/);
  assert.match(out, /\[strict\]/);
  assert.match(out, /p95 over threshold/);
});
