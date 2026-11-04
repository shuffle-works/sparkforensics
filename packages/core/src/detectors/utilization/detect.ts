import { MS_PER_CORE_HOUR } from '../../units.ts';
import { computeEfficiencyModel } from '../../efficiency-model.ts';
import { runTiming } from '../../run-timing.ts';
import { computePeakConcurrentCores } from '../../core-count.ts';
import { costOnly } from '../../impact-model.ts';
import { totalExecutorCpuMs } from '../../run-totals.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { defineAppDetector } from '../define.ts';
import { idleCapacityFix } from '../fixes.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface UtilizationEvidence {
  // CPU-time share of capacity, a companion to the busy-time `value`.
  cpuUtilizationPct: number | null;
}

export interface UtilizationFinding extends NumericFinding<'utilization'>, UtilizationEvidence {
  // Impact-estimator inputs: the unrounded `value`, the run's span, its peak cores, and the
  // allocated core-milliseconds (cores x time alive) the busy time was measured against.
  utilizationFraction: number;
  appDurationMs: number;
  totalCores: number;
  allocatedCoreMs: number;
}

export const utilizationDetector = defineAppDetector({
  type: 'utilization', order: 100, bandPolicy: 'own', fixEffort: 'config', version: 1,
  emits: ['utilization'],
  docAnchor: '#bottleneck-utilization',
  // Idle share grades: the finding fires under `minUtil` busy; the verdict note and the Scorecard
  // flag read idle at `1 - minUtil` as notable and at `1 - criticalUtil` as critical.
  thresholds: { minUtil: 0.60, criticalUtil: 0.30 },
  detect(ctx, thresholds): Finding | null {
    const { app, executorsAdded, executorsRemoved, runAggregates } = ctx;
    const appDuration = runTiming(app).durationMs;
    if (!app || executorsAdded.length === 0 || appDuration == null) return null;
    // Capacity is what the run was allocated (cores x time alive, the figure behind
    // metrics.allocation.coreHours), not peak concurrent cores x the whole run: under dynamic
    // allocation or late-joining executors that is more than was ever held, and the idle figure
    // would exceed the allocation. Null without executor cores.
    const { allocatedCoreMs: capacityCoreMs, utilization } = computeEfficiencyModel({
      app, stages: ctx.stages, executorsAdded, executorsRemoved, runAggregates,
    });
    if (capacityCoreMs == null || utilization == null) return null;
    // Peak concurrent cores (not computeTotalCores, a cumulative sum that double-counts a
    // churned-through executor against its replacement): the cluster size the finding reports.
    const totalCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);
    // Utilization is busy core-time (from the whole-run core-time-series) over the allocation, not
    // executor lifetime: an executor that exists for the whole run but sits fully idle must not
    // score as 100% used. Missing runAggregates (older callers, synthetic fixtures) reads as 0 busy time.
    if (utilization >= thresholds.minUtil) return null;

    // CPU-time-based utilization: metric only, no threshold.
    // Null when no stage recorded CPU time (older Spark), the same rule as the CLI metrics block.
    const cpuMs = totalExecutorCpuMs(ctx.stages.values());
    const cpuUtilizationPct = cpuMs == null ? null : Math.round((cpuMs / capacityCoreMs) * 100);

    const value = Math.round(utilization * 100);
    const fix = idleCapacityFix(app, 'consider either reducing cluster size (spark.executor.instances) or enabling dynamic allocation',
      'dynamic allocation is already on, so consider reducing cluster size');
    return {
      type: 'utilization', stageId: null, impactBand: 'warning',
      metric: 'avgUtilization', value,
      utilizationFraction: utilization,
      appDurationMs: appDuration,
      totalCores,
      allocatedCoreMs: capacityCoreMs,
      cpuUtilizationPct,
      recommendation: `Average executor utilization was only ${value}%: ${fix.text}.`,
      remediation: fix.remediation,
    };
  },
  estimate(finding): ImpactEstimate | null {
    const fraction = finding.utilizationFraction as number | undefined;
    const allocatedMs = finding.allocatedCoreMs as number | undefined;
    if (fraction == null || allocatedMs == null) {
      return costOnly('measured');
    }
    // The same allocated-minus-busy figure as `rawWaste`, in core-milliseconds, next to (never in)
    // coreTimeMs: that field is busy task time a fix removes, this is capacity no task used.
    const idleMs = (1 - fraction) * allocatedMs;
    return {
      ...costOnly('measured', { value: idleMs / MS_PER_CORE_HOUR, unit: 'coreHours', idle: true }),
      idleCoreTimeMs: { low: idleMs, high: idleMs },
    };
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  utilization: { finding: UtilizationFinding; evidence: UtilizationEvidence };
}

export const detectors = [utilizationDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  utilization: ['cpuUtilizationPct'],
} as const satisfies {
  utilization: readonly AllKeys<UtilizationEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  utilization: [],
} as const satisfies {
  utilization: readonly (DiscriminatorSlot & AllKeys<FindingOf<'utilization'>>)[];
};
