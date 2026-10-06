import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.ts';
import { buildEvidenceReport } from '../src/evidence-report.ts';
import { buildPlanGraphModel } from '../src/plan-graph-model.ts';
import { resolveOrCreateRun, getRunSummary } from '../src/mcp-tools.ts';

// Parity between the report's write targets (CLI JSON) and what the dashboard shows for the same
// plan nodes: both read PlanNode.metrics and the parser's skipped-line count, so one number must
// not be reported two ways. Public generated corpus logs; the local corpus is absent on some
// checkouts, where the suite skips.
const CORPUS = fileURLToPath(new URL('../../../dev/log-corpus/logs/', import.meta.url));
const LOGS = ['spark-4.2-parquet-baseline', 'spark-4.1-iceberg-baseline', 'spark-4.2-delta-baseline']
  .map((name) => `${CORPUS}${name}.ndjson`);
const present = LOGS.filter((p) => existsSync(p));

describe.skipIf(present.length === 0)('write targets agree with the dashboard model', () => {
  it.each(present)('%s', async (path) => {
    const { appModel, skippedLines } = await collectRun(path);
    const { json } = buildEvidenceReport(appModel, { markdown: false });
    const { writeTargets } = json;

    expect(writeTargets.writes.length).toBeGreaterThan(0);
    // One parser count feeds the dashboard's skipped-lines notice and the report.
    expect(writeTargets.skippedLines).toBe(skippedLines);
    expect(json.summary.sqlExecutionCount).toBe(appModel.sql.size);

    let compared = 0;
    for (const write of writeTargets.writes) {
      const exec = appModel.sql.get(write.sqlExecutionId);
      expect(exec, `execution ${write.sqlExecutionId} is in the model`).toBeDefined();
      // The plan graph the dashboard renders for a stage of this execution.
      const stage = [...appModel.stages.values()].find((s) => s.sqlExecutionId === write.sqlExecutionId);
      if (!stage) continue;
      const graph = buildPlanGraphModel(exec.planTree, { scope: 'full', stageId: stage.id, appModel });
      const card = graph.nodes.find((n) => n.sourceNodeId === write.nodeId);
      if (!card) continue;
      compared++;
      const shown = card.metrics.find((m) => m.name === 'number of output rows');
      if (write.outputRows === null) expect(shown).toBeUndefined();
      else expect(shown?.value).toBe(write.outputRows.toLocaleString('en-US'));
    }

    // Guards the loop above against passing by skipping every write. The Delta log's write runs no
    // stage, so the dashboard has no graph for it.
    if (path.includes('parquet')) expect(compared).toBeGreaterThan(0);

    // The MCP run summary reads the same model, so its counts match the report's.
    const { runId } = await resolveOrCreateRun({ source: { path } });
    expect(getRunSummary(runId).sqlExecutionCount).toBe(json.summary.sqlExecutionCount);
  });
});
