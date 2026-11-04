import { increaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { dynamicAllocationOff } from '../conf.ts';
import { defineAppDetector } from '../define.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface ColdStartEvidence {
  // 'off' when the run's conf turns dynamic allocation off: no executor-count property applies.
  dynamicAllocation?: 'on' | 'off';
}

export interface ColdStartFinding extends NumericFinding<'coldStart'>, ColdStartEvidence {}

export const coldStartDetector = defineAppDetector({
  type: 'coldStart', order: 90, bandPolicy: 'derived', fixEffort: 'code', version: 1,
  emits: ['coldStart'],
  docAnchor: '#bottleneck-cold-start',
  thresholds: { gapSeconds: 30 },
  detect(ctx, thresholds): Finding | null {
    const { app, stages, executorsAdded, executorsRemoved } = ctx;
    // Nullish (not falsy) check: a literal startTime:0 must not be treated as "missing".
    if (!app || app.startTime == null || stages.size === 0) return null;
    let firstStageSubmitted = Infinity;
    for (const stage of stages.values()) {
      if (stage.submittedAt > 0 && stage.submittedAt < firstStageSubmitted) firstStageSubmitted = stage.submittedAt;
    }
    // No stage ever recorded a submission timestamp: no basis to measure a startup gap against.
    if (!Number.isFinite(firstStageSubmitted)) return null;
    // The wait is from the first runnable stage to the first executor, not from app start: the
    // driver's own startup before its first job isn't something executors could shorten.
    // An executor added before the first stage only counts if it was still alive at submission:
    // with dynamic allocation scaling to zero, early executors can idle out before any job runs.
    const removedAt = new Map<string, number>();
    for (const ev of executorsRemoved) removedAt.set(ev.executorId, ev.timestamp);
    let firstExecutorAdded = Infinity;
    for (const e of executorsAdded) {
      if (!(e.timestamp > 0)) continue;
      if (e.timestamp <= firstStageSubmitted) {
        const removed = removedAt.get(e.executorId);
        if (removed == null || removed > firstStageSubmitted) return null;
      } else if (e.timestamp < firstExecutorAdded) {
        firstExecutorAdded = e.timestamp;
      }
    }
    if (!Number.isFinite(firstExecutorAdded)) return null;
    const gapSeconds = (firstExecutorAdded - firstStageSubmitted) / 1000;
    if (gapSeconds <= thresholds.gapSeconds) return null;
    const value = Math.round(gapSeconds);
    return {
      type: 'coldStart', stageId: null, impactBand: 'warning',
      dynamicAllocation: dynamicAllocationOff(ctx.app) ? 'off' : 'on',
      metric: 'startupGapSeconds', value,
      recommendation: `The first stage waited ${value}s for an executor to become available: keep a warm pool of idle executors, or if using dynamic allocation, raise the minimum/initial executor count so it doesn't scale up from zero.`,
      remediation: dynamicAllocationOff(ctx.app) ? [] : [increaseConf('spark.dynamicAllocation.minExecutors'), increaseConf('spark.dynamicAllocation.initialExecutors')],
    };
  },
  estimate(finding): ImpactEstimate | null {
    // detect() reports the gap as `metric: 'startupGapSeconds', value: <seconds>`.
    if (typeof finding.value !== 'number') return null;
    const wasteMs = finding.value * 1000;
    // Time before any task starts can never overlap any stage; a genuine unclipped point estimate,
    // not tied to any stage's gate (coldStart is app-scoped, stageId: null).
    return { basis: 'serial', wallClock: { low: wasteMs, high: wasteMs }, estimateMethod: 'measured' };
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  coldStart: { finding: ColdStartFinding; evidence: ColdStartEvidence };
}

export const detectors = [coldStartDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  coldStart: ['dynamicAllocation'],
} as const satisfies {
  coldStart: readonly AllKeys<ColdStartEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  coldStart: [],
} as const satisfies {
  coldStart: readonly (DiscriminatorSlot & AllKeys<FindingOf<'coldStart'>>)[];
};
