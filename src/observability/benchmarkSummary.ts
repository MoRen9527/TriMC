export function buildSqlBenchmarkSummary(report) {
  const evaluation = report?.evaluation || { passed: false, failures: ['missing evaluation'] };
  const query = report?.queryMs || {};
  const consistency = report?.consistency || {};

  const status = evaluation.passed ? 'PASS' : 'FAIL';
  const failureText = evaluation.failures?.length
    ? evaluation.failures.map((item) => `- ${item}`).join('\n')
    : '- none';

  return [
    `SQL Acceptance: ${status}`,
    `generatedAt: ${report.generatedAt || 'n/a'}`,
    `traceId: ${report.traceId || 'n/a'}`,
    `concurrency/pages/pageSize: ${report.concurrency ?? 'n/a'}/${report.pages ?? 'n/a'}/${report.pageSize ?? 'n/a'}`,
    `query p50/p95/max (ms): ${query.p50 ?? 'n/a'}/${query.p95 ?? 'n/a'}/${query.max ?? 'n/a'}`,
    `consistency unique/duplicate/order/empty: ${consistency.uniqueEventsSeen ?? 'n/a'}/${consistency.duplicateCount ?? 'n/a'}/${consistency.orderViolations ?? 'n/a'}/${consistency.emptyPages ?? 'n/a'}`,
    'failures:',
    failureText
  ].join('\n');
}

export function buildSqlBenchmarkSummaryMarkdown(report) {
  const evaluation = report?.evaluation || { passed: false, failures: ['missing evaluation'] };
  const query = report?.queryMs || {};
  const consistency = report?.consistency || {};
  const status = evaluation.passed ? 'PASS' : 'FAIL';
  const failures = evaluation.failures?.length ? evaluation.failures : ['none'];

  return [
    '# SQL Acceptance Summary',
    '',
    `- Status: **${status}**`,
    `- Generated At: ${report.generatedAt || 'n/a'}`,
    `- Trace ID: ${report.traceId || 'n/a'}`,
    `- Concurrency/Pages/PageSize: ${report.concurrency ?? 'n/a'}/${report.pages ?? 'n/a'}/${report.pageSize ?? 'n/a'}`,
    `- Query p50/p95/max (ms): ${query.p50 ?? 'n/a'}/${query.p95 ?? 'n/a'}/${query.max ?? 'n/a'}`,
    `- Consistency unique/duplicate/order/empty: ${consistency.uniqueEventsSeen ?? 'n/a'}/${consistency.duplicateCount ?? 'n/a'}/${consistency.orderViolations ?? 'n/a'}/${consistency.emptyPages ?? 'n/a'}`,
    '',
    '## Failures',
    '',
    ...failures.map((item) => `- ${item}`)
  ].join('\n');
}
