import { runTiming } from '../../run-timing.ts';
import { EXECUTOR_STARTUP_OVERHEAD_MS, costOnly } from '../../impact-model.ts';
import { decreaseConf, increaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { dynamicAllocationOff } from '../conf.ts';
import { autoscalingChurnConfidence } from '../confidence.ts';
import { defineAppDetector } from '../define.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface AutoscalingChurnEvidence {
  shortLivedExecutorCount: number;
  // 'off' when the run's conf turns dynamic allocation off: its properties have no effect.
  dynamicAllocation?: 'on' | 'off';
}

export interface AutoscalingChurnFinding extends NumericFinding<'autoscalingChurn'>, AutoscalingChurnEvidence {}

export const autoscalingChurnDetector = defineAppDetector({
  // Short-lived executors: stood up and torn down before doing useful work (wasteful
  // re-provisioning, not normal scale-down). Reuses utilization's add/remove matching, but
  // measures lifetime against a threshold instead of aggregate active-time.
  type: 'autoscalingChurn', order: 103, bandPolicy: 'own', fixEffort: 'config', version: 2,
  emits: ['autoscalingChurn'],
  docAnchor: '#bottleneck-autoscaling-churn',
  thresholds: { shortLivedMs: 120_000, warningPct: 0.30, criticalPct: 0.60, minExecutors: 5 },
  detect(ctx, thresholds): Finding | null {
    const { app, executorsAdded, executorsRemoved } = ctx;
    if (!app || executorsAdded.length === 0 || !runTiming(app).complete) return null;

    const removedAt = new Map<string, number>();
    for (const ev of executorsRemoved) removedAt.set(ev.executorId, ev.timestamp);

    // Only executors with a removal event have a measured lifetime. One still alive at app end
    // was never torn down, so it counts in neither the numerator nor the denominator.
    let removedCount = 0;
    let shortLivedCount = 0;
    for (const ev of executorsAdded) {
      const endedAt = removedAt.get(ev.executorId);
      if (endedAt === undefined) continue;
      removedCount++;
      if (endedAt - ev.timestamp < thresholds.shortLivedMs) shortLivedCount++;
    }
    if (removedCount < thresholds.minExecutors) return null;

    const shortLivedPct = shortLivedCount / removedCount;
    const impactBand = shortLivedPct > thresholds.criticalPct ? 'critical'
                      : shortLivedPct > thresholds.warningPct ? 'warning' : null;
    if (!impactBand) return null;

    const pct = Math.round(shortLivedPct * 100);
    const daOff = dynamicAllocationOff(app);
    return {
      type: 'autoscalingChurn', stageId: null, impactBand,
      metric: 'shortLivedExecutorPct', value: pct,
      // Raw count behind the percentage, for the impact estimator's startup-overhead figure.
      shortLivedExecutorCount: shortLivedCount,
      confidence: autoscalingChurnConfidence(shortLivedPct, thresholds.warningPct, thresholds.criticalPct),
      // No dynamic-allocation property has an effect when the run's conf turns it off (as for coldStart).
      dynamicAllocation: daOff ? 'off' : 'on',
      recommendation: daOff
        ? `${pct}% of removed executors ran for under 2 minutes: dynamic allocation is off, so the churn comes from executors lost or preempted, not from autoscaling bounds; check the cluster manager's preemption and executor-loss logs.`
        : `${pct}% of removed executors ran for under 2 minutes: this looks like wasteful re-provisioning rather than normal scale-down; consider raising spark.dynamicAllocation.executorIdleTimeout or widening the minExecutors/maxExecutors bounds to reduce flapping.`,
      remediation: daOff ? [] : [
        increaseConf('spark.dynamicAllocation.executorIdleTimeout'),
        decreaseConf('spark.dynamicAllocation.minExecutors'),
        increaseConf('spark.dynamicAllocation.maxExecutors'),
      ],
    };
  },
  estimate(finding): ImpactEstimate | null {
    const shortLived = (finding.shortLivedExecutorCount as number | undefined) ?? 0;
    const executorHours = (shortLived * EXECUTOR_STARTUP_OVERHEAD_MS) / 3.6e6;
    return costOnly('modeled', { value: executorHours, unit: 'coreHours' });
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  autoscalingChurn: { finding: AutoscalingChurnFinding; evidence: AutoscalingChurnEvidence };
}

export declare const emits: Emits;

export const detectors = [autoscalingChurnDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  autoscalingChurn: ['shortLivedExecutorCount', 'dynamicAllocation'],
} as const satisfies {
  autoscalingChurn: readonly AllKeys<AutoscalingChurnEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  autoscalingChurn: [],
} as const satisfies {
  autoscalingChurn: readonly (DiscriminatorSlot & AllKeys<FindingOf<'autoscalingChurn'>>)[];
};
