import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.js';
import { analyze, auditConfig } from '../src/analyzer.js';
import { deriveEvidenceAvailability } from '../src/evidence-availability.js';
import { buildEvidenceReport } from '../src/evidence-report.js';
import { buildExportRunData, CORE_VERSION } from '../src/export-data.js';
import { interpretRun } from '../src/run-interpretation.js';
import { resolveOrCreateRun, diagnoseRun } from '../src/mcp-tools.js';
import { buildComparison } from '../src/run-comparison.js';
import { computeRunMetrics } from '../src/run-metrics.js';
import { computeEfficiencyModel } from '../src/efficiency-model.js';

// Public corpus logs (dev/log-corpus submodule); the suite skips without it.
const EXTERNAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs', 'external');
const LOGS = existsSync(EXTERNAL_DIR)
  ? readdirSync(EXTERNAL_DIR).filter((f) => f.endsWith('.ndjson')).sort() : [];

// The fields this change adds or redefines, per finding, as each surface reads them.
// Through JSON, as the export and the CLI/MCP output carry them.
const shared = (f) => JSON.parse(JSON.stringify({
  recommendation: f.recommendation ?? null,
  remediation: f.remediation ?? [],
  impactEstimate: f.impactEstimate ?? null,
}));

describe.skipIf(LOGS.length === 0)('surface parity on public corpus logs', () => {
  it('the dashboard, HTML export, CLI report and MCP tools read one remediation and impact figure per finding', async () => {
    let withRemediation = 0;
    let withCoreTime = 0;
    for (const file of LOGS) {
      const path = join(EXTERNAL_DIR, file);
      const { appModel, skippedLines } = await collectRun(path);
      appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });

      // Dashboard: what useIngest stores from analyze()/auditConfig().
      const catalog = analyze(
        appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
        appModel.jobs, appModel.sql, appModel.runAggregates,
      );
      const config = auditConfig(appModel.app);
      const dashboard = new Map([...catalog, ...config].map((f) => [f.id, shared(f)]));

      // HTML export: the findings it ships for the dashboard bundle to render.
      const interpretation = interpretRun(appModel, catalog, config);
      const exported = buildExportRunData(
        appModel, catalog, config, skippedLines, interpretation,
        { coreVersion: CORE_VERSION, buildId: 'parity', producer: 'parity-test' },
      );
      const exportedFindings = new Map([...exported.catalog, ...exported.configFindings].map((f) => [f.id, shared(f)]));

      // CLI json and markdown path, and MCP diagnose_run.
      const { json } = buildEvidenceReport(appModel);
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const mcp = diagnoseRun(runId).findings;

      for (const [surface, rows] of [['cli', json.findings], ['mcp', mcp]]) {
        expect(rows.length, `${file} ${surface}`).toBe(dashboard.size);
        for (const row of rows) {
          expect(shared(row), `${file} ${surface} ${row.type} ${row.id}`).toEqual(dashboard.get(row.id));
        }
      }
      expect(exportedFindings, file).toEqual(dashboard);

      // The savings figure and its label ("of core time", "of idle core capacity") the dashboard
      // board shows are the ones the CLI and MCP rows carry.
      const cliById = new Map(json.findings.map((r) => [r.id, r]));
      const mcpById = new Map(mcp.map((r) => [r.id, r]));
      [...catalog, ...config].forEach((f, i) => {
        const { board, meaning } = interpretation.savings[i];
        if (board == null || f.impactEstimate?.wallClock) return;
        for (const [surface, row] of [['cli', cliById.get(f.id)], ['mcp', mcpById.get(f.id)]]) {
          expect({ impact: row.impact, impactMeaning: row.impactMeaning }, `${file} ${surface} ${f.type} ${f.id}`)
            .toEqual({ impact: board, impactMeaning: meaning });
        }
      });

      for (const v of dashboard.values()) {
        if (v.remediation.length) withRemediation += 1;
        if (v.impactEstimate?.coreTimeMs) withCoreTime += 1;
      }
    }
    // The comparison is not vacuous: the corpus exercises both new fields.
    expect(withRemediation).toBeGreaterThan(0);
    expect(withCoreTime).toBeGreaterThan(0);
  }, 120000);
});

// Public corpus logs (git submodule, checked out in CI; skipped locally until initialized).
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs', 'external');
const LOGS = [
  'external-app-20161115172038-0000.ndjson',
  'external-application_1516285256255_0012.ndjson',
  'external-application_1553914137147_0018.ndjson',
].map((name) => join(CORPUS, name));

// The CLI's metrics block, the evidence report (CLI md/json and MCP tools) and the run comparison
// (dashboard comparison view, CLI --baseline, MCP compare_runs) must agree on every figure they
// share. The comparison of a run with itself exposes its totals as baseline values.
describe.each(LOGS)('surface parity: %s', (path) => {
  it.skipIf(!existsSync(path))('reads one figure per name across metrics, report and comparison', async () => {
    const { appModel } = await collectRun(path);
    const catalog = analyze(
      appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
      appModel.jobs, appModel.sql, appModel.runAggregates,
    );
    const metrics = computeRunMetrics(appModel);
    const { json: report } = buildEvidenceReport(appModel);
    const side = { label: 'run', appModel, catalog };
    const byKey = Object.fromEntries(buildComparison(side, side).metrics.map((m) => [m.key, m.baseline]));

    // Run totals: the comparison reads the same sums.
    expect(byKey.executorRunTime).toEqual(metrics.time.executorRunTimeMs);
    expect(byKey.executorCpuTime).toEqual(metrics.time.executorCpuTimeMs);
    expect(byKey.gcTime).toEqual(metrics.time.gcTimeMs);
    expect(byKey.shuffleSpill).toEqual(metrics.data.memorySpillBytes);
    expect(byKey.diskSpill).toEqual(metrics.data.diskSpillBytes);
    expect(byKey.inputBytes).toEqual(metrics.data.inputBytes);
    expect(byKey.outputBytes).toEqual(metrics.data.outputBytes);
    expect(byKey.taskCount).toEqual(metrics.shape.taskCount);
    expect(byKey.allocatedCoreHours).toEqual(metrics.allocation.coreHours);
    if (metrics.shape.taskCount) expect(byKey.failedTaskRate).toBeCloseTo(metrics.shape.failedTasks / metrics.shape.taskCount, 10);

    // Run shape and status: the report's summary is the dashboard's and MCP's figure.
    expect(metrics.time.wallClockMs).toEqual(report.summary.runShape.wallClockMs);
    expect(metrics.shape.stageCount).toBe(report.summary.stageCount);
    expect(metrics.runComplete).toBe(!report.findings.some((f) => f.tag === 'INCMP'));

    // CPU utilization is unavailable exactly when the metrics block has no CPU time.
    const utilization = catalog.find((f) => f.type === 'utilization');
    if (utilization) expect(utilization.cpuUtilizationPct == null).toBe(metrics.time.executorCpuTimeMs == null);

    // The dashboard's capacity figure is a different quantity from allocated core-hours, and is
    // labeled "available": it must not be reported under the allocation name.
    const efficiency = computeEfficiencyModel({
      app: appModel.app, stages: appModel.stages, executorsAdded: appModel.executors.added,
      executorsRemoved: appModel.executors.removed, runAggregates: appModel.runAggregates,
    });
    expect(Number.isFinite(efficiency.availableComputeHours)).toBe(true);
  });
});
