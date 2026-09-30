import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../bin/sparkforensics-analyze.mjs';
import { collectRun } from '@sparkforensics/core/cli/collect-run.ts';
import { deriveEvidenceAvailability } from '@sparkforensics/core/evidence-availability.ts';
import { analyze } from '@sparkforensics/core/analyzer.ts';
import { buildComparison } from '@sparkforensics/core/run-comparison.ts';
import { comparisonVerdict } from '@sparkforensics/core/comparison-verdict.ts';
import { compareRuns, evaluateBudgetsForRun } from '@sparkforensics/core/mcp-tools.ts';

// The CLI's NDJSON lines, the MCP tools and the dashboard (which diffs two parsed runs with core's
// compareRuns, see src/App.tsx) must report the same comparison and the same budget results for
// the same pair of logs. Public corpus logs only.
const CORPUS = join(import.meta.dirname, '..', '..', '..', 'dev', 'log-corpus', 'logs', 'external');
const BASELINE = join(CORPUS, 'external-app-20161115172038-0000.ndjson');
const CANDIDATES = [
  join(CORPUS, 'external-app-20161116163331-0000.ndjson'),
  join(CORPUS, 'external-application_1516285256255_0012.ndjson'),
];

async function cliLines(argv) {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previous = process.exitCode;
  try {
    await main(argv);
    return out.mock.calls.map(([c]) => c).join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previous;
  }
}

// What the dashboard does: parse both runs, analyze, diff the two snapshots.
async function dashboardComparison(baselinePath, candidatePath) {
  const prepare = async (path) => {
    const { appModel, skippedLines } = await collectRun(path);
    appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
    const catalog = analyze(
      appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
      appModel.jobs, appModel.sql, appModel.runAggregates,
    );
    return { appModel, catalog };
  };
  const [base, cand] = await Promise.all([prepare(baselinePath), prepare(candidatePath)]);
  return buildComparison({ label: 'baseline', ...base }, { label: 'candidate', ...cand });
}

const shared = (c) => ({
  verdict: c.verdict, confidence: c.confidence, reason: c.reason, matchedCoverage: c.matchedCoverage,
  metrics: c.metrics, findings: c.findings,
});

describe.skipIf(!existsSync(BASELINE))('CLI, MCP and dashboard parity on public corpus logs', () => {
  it.each(CANDIDATES)('reports the same comparison for %s', async (candidate) => {
    const [line] = await cliLines([candidate, '--baseline', BASELINE, '--format', 'ndjson']);
    const mcp = await compareRuns({ source: { path: BASELINE } }, { source: { path: candidate } });
    const dashboard = await dashboardComparison(BASELINE, candidate);

    expect(line.comparison.metrics.find((m) => m.key === 'wallClock')).toMatchObject({ baseline: expect.any(Number), candidate: expect.any(Number) });
    expect(line.comparison).toEqual(shared({ ...dashboard, verdict: comparisonVerdict(dashboard) }));
    expect(shared({
      verdict: mcp.verdict, confidence: mcp.confidence, reason: mcp.reason,
      matchedCoverage: mcp.matchedCoverage, metrics: mcp.metricDeltas, findings: mcp.findingsDelta,
    })).toEqual(line.comparison);
  });

  it('reports the same budget results as MCP evaluate_budgets', async () => {
    const candidate = CANDIDATES[0];
    const [line] = await cliLines([
      candidate, '--baseline', BASELINE, '--regression-budget', 'wallClock:5',
      '--regression-budget', 'gcTime:5', '--format', 'ndjson',
    ]);
    const viaMcp = async (metric) => (await evaluateBudgetsForRun(
      { source: { path: BASELINE } }, { maxRegressionPct: 5, regressionMetric: metric }, { source: { path: candidate } },
    )).results.find((r) => r.name === 'max-regression');
    for (const metric of ['wallClock', 'gcTime']) {
      expect(line.budgets.find((r) => r.metric === metric)).toEqual(await viaMcp(metric));
    }
  });
});
