import { formatBytes, formatDuration } from '../../units.ts';
import { walkPlanTree } from '../../plan-tree-walk.ts';
import { isBatchEvalPythonNode } from '../../python-stage.ts';
import { noWasteModel } from '../../impact-model.ts';
import type { Finding, PlanNode, FindingOf } from '../../types.ts';
import type { Remediation, AllKeys } from '../../finding-types.ts';
import { loggedAs, queryApp } from '../conf.ts';
import { defineSqlDetector } from '../define.ts';
import { switchFix } from '../fixes.ts';
import { unionStageIds } from '../plan-attribution.ts';
import type { DetectorApp } from '../types.ts';
import { MB } from '../units.ts';
import type { NumericFinding, PlanFindingEvidence, PlanNodeOrigin } from '../finding-bases.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface PythonUdfEvidence extends PlanFindingEvidence {
  // Bytes the executors sent to Python workers: the finding's `value`, repeated for the report.
  dataSentBytes: number;
  // Bytes the workers returned; null when the plan reports no such metric.
  dataReturnedBytes: number | null;
  // Summed wall-clock of the stages that ran the row-at-a-time UDFs, ms.
  stageDurationMs: number;
}

export interface PythonUdfFinding extends NumericFinding<'pythonUdf'>, PythonUdfEvidence, PlanNodeOrigin {}

const PYTHON_UDF_ARROW_KEY = 'spark.sql.execution.pythonUDF.arrow.enabled';

// The executor-side metrics of the Python evaluator operators. Spark's PythonSQLMetrics trait adds
// them in 3.4.0, the release that also adds the Arrow-optimized UDF property, so an older log never
// reports them and the detector skips it.
const PYTHON_DATA_SENT = 'data sent to Python workers';

const PYTHON_DATA_RETURNED = 'data returned from Python workers';

// How to cut the cost of a row-at-a-time Python UDF: the Arrow-optimized UDF property while the
// session lacks it, else what is left once it is on (a UDF that opted out with useArrow=False, takes no
// arguments, or was created before the property was set: all of them still run as BatchEvalPython).
function pythonUdfArrowFix(app: DetectorApp | null): { text: string; remediation: Remediation[] } {
  return switchFix(
    loggedAs(app, PYTHON_UDF_ARROW_KEY, true), PYTHON_UDF_ARROW_KEY, true,
    `set ${PYTHON_UDF_ARROW_KEY}=true to ship rows in Arrow batches, or rewrite the UDF as a pandas UDF.`,
    `Arrow-optimized Python UDFs are already on for the session, so this UDF may have opted out with useArrow=False, take no arguments, or have been created before the property was set: check which, or rewrite it as a pandas UDF.`,
  );
}

export const pythonUdfDetector = defineSqlDetector({
  type: 'pythonUdf', order: 134, bandPolicy: 'own', fixEffort: 'code', version: 1,
  emits: ['pythonUdf'],
  docAnchor: '#pyspark',
  // Unvalidated against a real workload (no corpus or private log runs a Python UDF): set high so
  // only a stage that moved a lot of data for a long time is flagged.
  thresholds: { minBytesSent: 64 * MB, minStageMs: 30_000 },
  detect(sqlExec, ctx, thresholds): Finding[] | null {
    if (!sqlExec.planTree) return null;
    const { minBytesSent, minStageMs } = thresholds;
    // BatchEvalPython runs a row-at-a-time UDF; ArrowEvalPython (an Arrow-optimized or pandas UDF)
    // is already the fix. Both Python byte metrics are executor-side; a plan that reports no sent
    // bytes is skipped.
    const nodes: PlanNode[] = [];
    let sentBytes = 0;
    let returnedBytes = 0;
    let reportsReturned = false;
    walkPlanTree(sqlExec.planTree, (node) => {
      if (!isBatchEvalPythonNode(node)) return;
      const sent = node.metrics?.find((m) => m.name === PYTHON_DATA_SENT)?.value;
      if (sent == null || !(node.stageIds?.length)) return;
      nodes.push(node);
      sentBytes += sent;
      const returned = node.metrics?.find((m) => m.name === PYTHON_DATA_RETURNED)?.value;
      if (returned != null) { returnedBytes += returned; reportsReturned = true; }
    });
    if (nodes.length === 0 || !(sentBytes >= minBytesSent)) return null;
    const stageIds = unionStageIds(nodes, []);
    const stageDurationMs = stageIds.reduce((sum, id) => {
      const stage = ctx.stages.get(id);
      return sum + Math.max(0, (stage?.completedAt ?? 0) - (stage?.submittedAt ?? 0));
    }, 0);
    if (!(stageDurationMs >= minStageMs)) return null;

    const arrowFix = pythonUdfArrowFix(queryApp(ctx.app, sqlExec.modifiedConfigs));
    const traffic = `sent ${formatBytes(sentBytes)} to Python workers${reportsReturned ? ` and received ${formatBytes(returnedBytes)} back` : ''}`;
    return [{
      type: 'pythonUdf', executionId: sqlExec.id, stageIds, planNodeIds: nodes.flatMap(n => (n.id ? [n.id] : [])),
      impactBand: 'info',
      metric: 'dataSentBytes', value: sentBytes,
      dataSentBytes: sentBytes, dataReturnedBytes: reportsReturned ? returnedBytes : null, stageDurationMs,
      recommendation: `Row-at-a-time Python UDFs (BatchEvalPython) ${traffic} over ${formatDuration(stageDurationMs)} of stage time: ${arrowFix.text}`,
      remediation: arrowFix.remediation,
    }];
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  pythonUdf: { finding: PythonUdfFinding; evidence: PythonUdfEvidence };
}

export declare const emits: Emits;

export const detectors = [pythonUdfDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  pythonUdf: ['executionId', 'stageIds', 'dataSentBytes', 'dataReturnedBytes', 'stageDurationMs'],
} as const satisfies {
  pythonUdf: readonly AllKeys<PythonUdfEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  pythonUdf: [],
} as const satisfies {
  pythonUdf: readonly (DiscriminatorSlot & AllKeys<FindingOf<'pythonUdf'>>)[];
};
