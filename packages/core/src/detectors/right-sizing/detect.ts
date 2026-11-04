import { formatDuration } from '../../units.ts';
import { runTiming } from '../../run-timing.ts';
import { computePeakConcurrentCores } from '../../core-count.ts';
import { smallestCoresWithinTolerance } from '../../scaling-sim.ts';
import { computeWallClock } from '../../wall-clock.ts';
import { noWasteModel } from '../../impact-model.ts';
import type { Finding, FindingOf } from '../../types.ts';
import { defineAppDetector } from '../define.ts';
import { idleCapacityFix } from '../fixes.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

// `value` is the modeled core count: the smallest whose makespan stays within the detector's
// tolerance of the observed stages-active time (`observedActiveMs`), `modeledActiveMs` at that count.
export interface RightSizingEvidence {
  observedCores: number;
  observedActiveMs: number;
  modeledActiveMs: number;
  // Idealized makespan at `observedCores` against `observedActiveMs`: how far to trust the model.
  modelErrorPct: number;
}

export interface RightSizingFinding extends NumericFinding<'rightSizing'>, RightSizingEvidence {}

export const rightSizingDetector = defineAppDetector({
  // The what-if scaling model (scaling-sim.ts) as a recommendation: the smallest core count whose
  // modeled stage time stays within tolerance of the observed one. `utilization` measures idle
  // allocation; this names the size the stages' own parallelism needs. The model is idealized, so
  // the finding is always low confidence and silent when the model misses the observed run.
  type: 'rightSizing', order: 101, bandPolicy: 'own', fixEffort: 'config', version: 1,
  emits: ['rightSizing'],
  docAnchor: '#bottleneck-utilization',
  thresholds: { tolerancePct: 10, maxCoreShare: 0.75, minBaselineCores: 8, maxModelErrorPct: 20 },
  detect(ctx, thresholds): Finding | null {
    const { app, executorsAdded, executorsRemoved, runAggregates, stages } = ctx;
    const perStage = runAggregates?.perStage;
    if (!app || !perStage || !runTiming(app).complete) return null;
    const observedCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);
    if (observedCores < thresholds.minBaselineCores) return null;
    const observedActiveMs = computeWallClock(app, stages).stagesActive;
    const fit = smallestCoresWithinTolerance({ perStage, baselineCores: observedCores, observedActiveMs, tolerancePct: thresholds.tolerancePct });
    if (fit == null || fit.modelErrorPct > thresholds.maxModelErrorPct) return null;
    if (fit.cores > observedCores * thresholds.maxCoreShare) return null;

    const fix = idleCapacityFix(app, 'consider either reducing cluster size (spark.executor.instances) or enabling dynamic allocation',
      'dynamic allocation is already on, so consider reducing cluster size');
    return {
      type: 'rightSizing', stageId: null, impactBand: 'warning',
      metric: 'rightSizedCores', value: fit.cores,
      observedCores, observedActiveMs, modeledActiveMs: fit.estMakespanMs, modelErrorPct: fit.modelErrorPct,
      confidence: 'low',
      validationRequired: `The model spreads each stage's tasks evenly over the cores and ignores scheduling and shuffle costs. At ${observedCores} cores it misses the real time by ${fit.modelErrorPct}%. The scaling card can show a different error, because it counts every executor ever added. Re-run with fewer cores to check.`,
      recommendation: `At its peak the run held ${observedCores} cores. A simple model predicts that about ${fit.cores} would run the stages in ${formatDuration(fit.estMakespanMs)}, within ${thresholds.tolerancePct}% of the ${formatDuration(observedActiveMs)} they took: ${fix.text}.`,
      remediation: fix.remediation,
    };
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  rightSizing: { finding: RightSizingFinding; evidence: RightSizingEvidence };
}

export declare const emits: Emits;

export const detectors = [rightSizingDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  rightSizing: ['observedCores', 'observedActiveMs', 'modeledActiveMs', 'modelErrorPct'],
} as const satisfies {
  rightSizing: readonly AllKeys<RightSizingEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  rightSizing: [],
} as const satisfies {
  rightSizing: readonly (DiscriminatorSlot & AllKeys<FindingOf<'rightSizing'>>)[];
};
