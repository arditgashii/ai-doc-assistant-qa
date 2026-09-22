import { test, expect, pdf } from '../support/fixtures';

const RUNS = Number(process.env.RELIABILITY_RUNS || 150);
const P95_BUDGET_MS = Number(process.env.P95_BUDGET_MS || 2000);

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/**
 * "Occasional 500, cannot reproduce" is a volume problem. Repeat the same request
 * many times with concurrency and look at the error rate and the latency spread.
 */
test.describe('Reliability and performance @reliability', () => {
  test.setTimeout(120_000);

  test('No 5xx across repeated concurrent questions, and p95 within budget', async ({ alice }, testInfo) => {
    const docId = await alice.uploadOk('reliability.pdf', pdf('The data retention period is 7 years.'));
    const statuses: Record<number, number> = {};
    const latencies: number[] = [];
    const failures: string[] = [];

    const batch = 10;
    for (let i = 0; i < RUNS; i += batch) {
      await Promise.all(
        Array.from({ length: Math.min(batch, RUNS - i) }, async () => {
          const start = Date.now();
          const res = await alice.ask('What is the data retention period?', { documentIds: [docId] });
          latencies.push(Date.now() - start);
          statuses[res.status()] = (statuses[res.status()] || 0) + 1;
          if (res.status() !== 200) failures.push(`${res.status()} ${(await res.text()).slice(0, 120)}`);
        }),
      );
    }

    const report = {
      runs: RUNS,
      statuses,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Math.max(...latencies),
      sampleFailures: failures.slice(0, 5),
    };
    await testInfo.attach('reliability-report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    console.log('Reliability report', report);

    expect(failures, `non 200 responses: ${JSON.stringify(report)}`).toHaveLength(0);
    expect(report.p95, 'p95 latency').toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
