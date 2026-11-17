import { retryWallClockMs, singleStageImpact } from '../../impact-model.ts';
import { adviseFailureGroup } from '../../failure-advice.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { defineStageDetector } from '../define.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys, TaskAttemptSample } from '../../finding-types.ts';
import type { ExecutorLossGroup } from '../../task-failure.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface RetryWasteEvidence {
  numTasks: number;
  memoryBytesSpilled: number;
  retriedTaskDetails: TaskAttemptSample[];
  // Executor losses among the retried attempts, by executor and cause, most frequent first.
  executorLosses: ExecutorLossGroup[];
}

export interface RetryWasteFinding extends NumericFinding<'retryWaste'>, RetryWasteEvidence {
  // The dashboard's longer explanation of the waste, display copy rather than evidence.
  extended?: string;
}

const CLUSTER_LOSS_ADVICE = 'the executor exits were unrelated to the running tasks (for example preemption, node loss, or a container the resource manager or driver released), so they do not count toward spark.task.maxFailures. Check cluster events for the lost executors; application code is not the cause.';

export const retryWasteDetector = defineStageDetector({
  type: 'retryWaste', order: 45, bandPolicy: 'derived', fixEffort: 'code', version: 2,
  emits: ['retryWaste'],
  docAnchor: '#bottleneck-retry-waste',
  thresholds: { minWasted: 3, minWasteMs: 30000 },
  detect(stage, _ctx, thresholds): Finding | null {
    const wasted = stage.wastedAttempts ?? 0;
    const wastedMs = stage.retryWasteMs ?? 0;
    if (wasted < thresholds.minWasted || wastedMs < thresholds.minWasteMs) return null;
    // From the retried attempts themselves: when the retries succeed, no failure stays on the stage.
    const topGroup = stage.retryFailureGroups?.[0];
    const advice = adviseFailureGroup(topGroup);
    // Spark does not count these losses toward spark.task.maxFailures: the cluster took the executor.
    const clusterLoss = topGroup?.exitCausedByApp === false;
    return {
      type: 'retryWaste', stageId: stage.id,
      impactBand: 'warning',
      metric: 'retryWasteMs', value: wastedMs,
      numTasks: stage.taskCount,
      memoryBytesSpilled: stage.memoryBytesSpilled,
      retriedTaskDetails: stage.retryTaskSamples ?? [],
      executorLosses: stage.retryExecutorLosses ?? [],
      recommendation: `Retried task attempts wasted ${Math.round(wastedMs / 1000)}s of executor time (${wasted} attempt${wasted === 1 ? '' : 's'}) even though the stage completed: ${clusterLoss ? CLUSTER_LOSS_ADVICE : (advice?.recommendation ?? 'investigate executor loss or fetch failures.')}`,
      ...(advice && { remediation: advice.remediation }),
      extended: `${wasted} task attempts were superseded by a later retry, wasting ${Math.round(wastedMs / 1000)}s of executor time. Common causes: executor loss (OOM-kill, node death) or shuffle FetchFailed forcing a stage-map recompute. Check driver logs for the dominant reason (see the Failures widget) even if the final failure rate looks low; retries hide the true cost.`,
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    // The waste figure lives on the Stage, not the Finding: detect() only re-publishes it as metric/value.
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const wasteMs = (stage.retryWasteMs as number | undefined) ?? 0;
    const wallClockMs = retryWallClockMs(stage);
    return singleStageImpact(wallClockMs, finding.stageId, ctx,
      wallClockMs === wasteMs ? 'measured' : 'modeled', { value: wasteMs, unit: 'ms' });
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  retryWaste: { finding: RetryWasteFinding; evidence: RetryWasteEvidence };
}

export declare const emits: Emits;

export const detectors = [retryWasteDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  retryWaste: ['numTasks', 'memoryBytesSpilled', 'retriedTaskDetails', 'executorLosses'],
} as const satisfies {
  retryWaste: readonly AllKeys<RetryWasteEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  retryWaste: [],
} as const satisfies {
  retryWaste: readonly (DiscriminatorSlot & AllKeys<FindingOf<'retryWaste'>>)[];
};
