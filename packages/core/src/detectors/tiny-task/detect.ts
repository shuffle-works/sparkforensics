import { TASK_SCHEDULING_OVERHEAD_MS, measuredTaskOverhead, singleStageImpact } from '../../impact-model.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { defineStageDetector } from '../define.ts';
import { stageReads, tinyShuffleFix } from '../partition.ts';
import { stageBelowRuntimeFloor } from '../runtime-floor.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys, StageReads } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface TinyTaskEvidence {
  // What the stage reads: the shuffle-partition remedy applies only to 'shuffle'.
  reads?: StageReads;
}

export interface TinyTaskFinding extends NumericFinding<'tinyTask'>, TinyTaskEvidence {}

export const tinyTaskDetector = defineStageDetector({
  type: 'tinyTask', order: 80, bandPolicy: 'derived', fixEffort: 'code', version: 1,
  emits: ['tinyTask'],
  docAnchor: '#bottleneck-tiny-tasks',
  // stageFloorPct: the tiered detectors' 0.5% runtime floor. Coalescing can't save more than the
  // stage's own duration, so on a shorter stage every finding would grade info.
  thresholds: { minTasks: 100, maxP50: 500, maxP95: 1000, stageFloorPct: 0.005 },
  detect(stage, ctx, thresholds): Finding | null {
    if (stage.taskCount < thresholds.minTasks) return null;
    if (stageBelowRuntimeFloor(stage, ctx, thresholds.stageFloorPct)) return null;
    if (stage.taskDurationP50 > thresholds.maxP50 || stage.taskDurationP95 > thresholds.maxP95) return null;
    const coalesceTo = Math.max(1, Math.round(stage.taskCount / 10));
    const reads = stageReads(stage);
    const fix = reads === 'shuffle' ? tinyShuffleFix(stage, ctx, coalesceTo) : { text: `.coalesce(${coalesceTo})`, remediation: [] };
    return {
      type: 'tinyTask', stageId: stage.id, impactBand: 'info', reads,
      metric: 'taskDurationP50', value: Math.round(stage.taskDurationP50),
      recommendation: `Many small tasks (${stage.taskCount}, P50 ${Math.round(stage.taskDurationP50)}ms): scheduler overhead may dominate. Try ${fix.text}.`,
      remediation: fix.remediation,
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const taskCount = stage.taskCount ?? 0;
    const excessTaskCount = Math.max(0, taskCount - Math.round(taskCount / 10));
    const measured = measuredTaskOverhead(stage);
    if (measured) {
      // Coalescing to a tenth of the tasks removes the excess tasks' per-task overhead: core
      // time spent in parallel, so wall-clock at the stage's achieved concurrency (floored at
      // 1: a mostly-idle stage can't save more wall-clock than the task time it removes).
      const wasteMs = (excessTaskCount * measured.perTaskMs) / Math.max(1, measured.concurrency);
      return singleStageImpact(wasteMs, finding.stageId, ctx, 'measured', { value: wasteMs, unit: 'ms' });
    }
    const wasteMs = excessTaskCount * TASK_SCHEDULING_OVERHEAD_MS;
    return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', { value: wasteMs, unit: 'ms' });
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  tinyTask: { finding: TinyTaskFinding; evidence: TinyTaskEvidence };
}

export declare const emits: Emits;

export const detectors = [tinyTaskDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  tinyTask: ['reads'],
} as const satisfies {
  tinyTask: readonly AllKeys<TinyTaskEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  tinyTask: [],
} as const satisfies {
  tinyTask: readonly (DiscriminatorSlot & AllKeys<FindingOf<'tinyTask'>>)[];
};
