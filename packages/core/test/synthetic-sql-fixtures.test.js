import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.ts';
import { buildEvidenceReport } from '../src/evidence-report.ts';

// Hand-made logs of tiny Spark SQL jobs (test/fixtures/synthetic/), each built to trigger one plan
// detector at its default thresholds. They double as the example data on the detector pages.
const CASES = [
  { file: 'python-udf', type: 'pythonUdf', evidence: { dataSentBytes: 1_150_000_000, dataReturnedBytes: 192_000_000 }, text: 'BatchEvalPython' },
  { file: 'over-broadcast', type: 'overBroadcast', evidence: { broadcastThreshold: 'notLimiting' }, text: 'broadcast() hint forced it' },
  { file: 'unpruned-scan', type: 'unprunedScan', evidence: { partitionsRead: 365, relation: 'default.events' }, text: 'No partition filter reached the scan' },
];

describe.each(CASES)('synthetic SQL fixture $file', ({ file, type, evidence, text }) => {
  it(`parses cleanly and reports ${type} at default thresholds`, async () => {
    const { appModel, skippedLines } = await collectRun(fileURLToPath(new URL(`./fixtures/synthetic/${file}.ndjson`, import.meta.url)));
    expect(skippedLines).toBe(0);
    const { json } = buildEvidenceReport(appModel, { markdown: false });
    expect(json.summary.skippedLines).toBe(0);
    const found = json.findings.filter((f) => f.type === type);
    expect(found).toHaveLength(1);
    expect(found[0].evidence).toMatchObject(evidence);
    expect(found[0].recommendation).toContain(text);
  });
});
