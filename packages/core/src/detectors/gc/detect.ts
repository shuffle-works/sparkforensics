import { executorHeapPeaks } from '../../executor-peaks.ts';
import { costOnly, singleStageImpact } from '../../impact-model.ts';
import { decreaseConf, increaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { gcConfidence } from '../confidence.ts';
import { defineStageDetector } from '../define.ts';
import { stageBelowRuntimeFloor } from '../runtime-floor.ts';
import type { DetectorCtx } from '../types.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface GcEvidence {
  // Only on the low-GC (over-provisioned memory) branch.
  direction?: 'low';
}

export interface GcFinding extends NumericFinding<'gc'>, GcEvidence {}

// Whether memoryUtilization can judge the executor heap: a measured peak and a known executor size.
// Without both, the stage-level low-GC note is the only memory-sizing signal there is.
function heapJudgementAvailable(ctx: Pick<DetectorCtx, 'stages' | 'runAggregates' | 'app'>): boolean {
  return executorHeapPeaks(ctx).size > 0 && (ctx.app?.resources?.executor?.memoryMB ?? 0) > 0;
}

// Caveats that name a threshold read it from the thresholds the detector ran with, so a tuned run
// states the floor it actually used.
function gcValidation(minRunTimeMs: number): string {
  return `Checked only on stages with at least ${minRunTimeMs / 1000}s of executor run time.`;
}

export const gcDetector = defineStageDetector({
  type: 'gc', order: 50, bandPolicy: 'derived', fixEffort: 'config', version: 1,
  emits: ['gc'],
  docAnchor: '#bottleneck-gc',
  thresholds: {
    warnPct100: 10,
    // A GC share below this reads as over-provisioned memory (the low-GC note).
    lowInfoPct100: 5,
    // Noise floor so a stage that barely ran doesn't flag either direction.
    minRunTimeMs: 10000,
    // lowInfoFloorPct: the 0.5% runtime floor stageShape's lowParallelism uses. The low-GC note is
    // an app-level memory-sizing signal; on a stage shorter than this share of the run it adds
    // nothing to that call.
    lowInfoFloorPct: 0.005,
  },
  detect(stage, ctx, thresholds): Finding | null {
    const pct = stage.gcPct;
    if ((stage.executorRunTime ?? 0) >= thresholds.minRunTimeMs
        && pct > thresholds.warnPct100) {
      const value = Math.round(pct * 10) / 10;
      return {
        type: 'gc', stageId: stage.id,
        impactBand: 'warning',
        metric: 'gcPct', value,
        confidence: gcConfidence(pct, thresholds, 'high'), validationRequired: gcValidation(thresholds.minRunTimeMs),
        recommendation: `GC consumed ${value}% of executor run time: reduce object creation, use primitive types, avoid UDFs, increase executor memory.`,
        remediation: [increaseConf('spark.executor.memory')],
      };
    }
    // Low-GC (cost) branch: only for stages that ran long enough to be meaningful, and only as
    // the fallback sizing signal: a log with measured executor heap peaks and a known executor
    // memory gets memoryUtilization's heapOverProvisioned judgement instead (low GC time just
    // means a low allocation rate).
    if ((stage.executorRunTime ?? 0) >= thresholds.minRunTimeMs
        && !heapJudgementAvailable(ctx)
        // A stage that failed, or lost tasks, ran too little work to call its GC low.
        && stage.stageFailureReason == null && stage.failedTasks === 0
        && pct < thresholds.lowInfoPct100
        && !stageBelowRuntimeFloor(stage, ctx, thresholds.lowInfoFloorPct)) {
      const value = Math.round(pct * 10) / 10;
      return {
        type: 'gc', stageId: stage.id, direction: 'low',
        impactBand: 'info',
        metric: 'gcPct', value,
        confidence: gcConfidence(pct, thresholds, 'low'), validationRequired: gcValidation(thresholds.minRunTimeMs),
        recommendation: `GC consumed only ${value}% of executor run time: memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.`,
        remediation: [decreaseConf('spark.executor.memory')],
      };
    }
    return null;
  },
  estimate(finding, ctx): ImpactEstimate | null {
    // The low-GC branch is an over-provisioning signal whose fix (less executor memory) raises
    // GC rather than recovering it: the stage's GC time is no saving there, so no waste model.
    if (finding.direction === 'low') return costOnly('none');
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
    const executorRunTime = stage.executorRunTime ?? 0;
    const jvmGCTime = stage.jvmGCTime ?? 0;
    // The raw cross-task core-time sum, before any conversion: the one figure here
    // that is straight from the log rather than modeled.
    const rawWaste = { value: jvmGCTime, unit: 'coreMs' } as const;
    if (executorRunTime <= 0 || stageDurationMs <= 0) {
      return costOnly('modeled', rawWaste);
    }
    const avgConcurrency = executorRunTime / stageDurationMs;
    // jvmGCTime is a cross-task core-time sum (same shape as executorRunTime); dividing by the
    // stage's average concurrency converts it to an approximate wall-clock figure. Modeled, not exact.
    const wasteMs = jvmGCTime / avgConcurrency;
    return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', rawWaste);
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  gc: { finding: GcFinding; evidence: GcEvidence };
}

export const detectors = [gcDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  gc: ['direction'],
} as const satisfies {
  gc: readonly AllKeys<GcEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  gc: ['direction'],
} as const satisfies {
  gc: readonly (DiscriminatorSlot & AllKeys<FindingOf<'gc'>>)[];
};
