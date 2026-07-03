export function buildSqlWeeklyIssueReport({
  report,
  summaryMarkdownPath,
  benchmarkJsonPath,
  generatedAt = new Date().toISOString(),
  status = report?.evaluation?.passed ? 'PASS' : 'FAIL',
  gateProfile
}) {
  const maxP95 = Number(report?.thresholds?.maxP95Ms);
  const inferredProfile = gateProfile
    || (Number.isFinite(maxP95) ? (maxP95 <= 50 ? 'strict' : 'baseline') : 'baseline');

  const q = report?.queryMs || {};
  const c = report?.consistency || {};
  const failures = report?.evaluation?.failures?.length
    ? report.evaluation.failures.map((item) => `- ${item}`).join('\n')
    : '- none';

  return [
    `# [Weekly][SQL Acceptance][${inferredProfile}] #18 运行结果`,
    '',
    `- Status: **${status}**`,
    `- Gate Profile: ${inferredProfile}`,
    `- Generated At: ${generatedAt}`,
    `- Trace ID: ${report?.traceId || 'n/a'}`,
    `- Query p50/p95/max (ms): ${q.p50 ?? 'n/a'}/${q.p95 ?? 'n/a'}/${q.max ?? 'n/a'}`,
    `- Consistency unique/duplicate/order/empty: ${c.uniqueEventsSeen ?? 'n/a'}/${c.duplicateCount ?? 'n/a'}/${c.orderViolations ?? 'n/a'}/${c.emptyPages ?? 'n/a'}`,
    '',
    '## Evidence',
    '',
    `- Benchmark JSON: ${benchmarkJsonPath}`,
    `- Acceptance Summary (Markdown): ${summaryMarkdownPath}`,
    '',
    '## Failures',
    '',
    failures,
    '',
    '## Next',
    '',
    '- If PASS: keep thresholds and continue trend tracking.',
    '- If FAIL: inspect failures and adjust index/query plan or threshold after root-cause analysis.'
  ].join('\n');
}
