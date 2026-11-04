import { costOnly } from '../../impact-model.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { defineStageDetector } from '../define.ts';
import { stageBelowRuntimeFloor } from '../runtime-floor.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface StageShapeEvidence {
  rule: 'lowParallelism' | 'dataExplosion' | 'taskStageSkew';
}

export interface StageShapeFinding extends NumericFinding<'stageShape'>, StageShapeEvidence {
  // Absolute core count behind pRatio/taskStageSkew, for the impact estimator's idle-core-ms figure.
  totalCores?: number;
}

export const stageShapeDetector = defineStageDetector({
  type: 'stageShape', order: 35, bandPolicy: 'own', fixEffort: 'code', version: 2,
  emits: ['stageShape'],
  docAnchor: '#bottleneck-stage-shape',
  // lowParallelismFloorPct: the same 0.5% runtime floor the tiered detectors use. Parallelizing a
  // stage can't save more than the stage's own duration, so a shorter stage can't clear it.
  // App-wide idle capacity stays covered by utilization.
  // taskStageSkew: stageShareMin is the share of the stage's wall-clock the longest task must
  // span, and skewWarn how far past the median task it must run (skew's own max/median 3×).
  // The share alone can't tell a straggler apart: on a single wave (tasks <= cores) the longest
  // task spans nearly the whole stage however even the tasks are. taskStageSkewFloorPct is the
  // same 0.5% runtime floor as lowParallelismFloorPct.
  thresholds: {
    pRatioMax: 0.5, oiRatioMax: 10, skewWarn: 3, stageShareMin: 0.5,
    lowParallelismFloorPct: 0.005, taskStageSkewFloorPct: 0.005,
  },
  detect(stage, ctx, thresholds): Finding[] {
    const out: Finding[] = [];
    const execCount = (stage.executorStats ?? []).length;
    const cores = ctx.app?.resources?.executor?.cores ?? 1;
    const totalCores = execCount * cores;
    const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
    // PRatio: under-parallelization.
    if (totalCores > 0 && !stageBelowRuntimeFloor(stage, ctx, thresholds.lowParallelismFloorPct)) {
      const pRatio = stage.taskCount / totalCores;
      if (pRatio < thresholds.pRatioMax) {
        out.push({
          type: 'stageShape', stageId: stage.id, impactBand: 'info',
          rule: 'lowParallelism', metric: 'pRatio', value: Math.round(pRatio * 100) / 100,
          // Absolute core count behind pRatio, for the impact estimator's idle-core-ms figure.
          totalCores,
          recommendation: `This stage runs ${stage.taskCount} ${stage.taskCount === 1 ? 'task' : 'tasks'} across ~${totalCores} cores: it is under-parallelized and leaves cluster capacity idle.`,
        });
      }
    }
    // OIRatio: data explosion. Skip when inputBytes is 0 (Infinity guard).
    if (stage.inputBytes > 0) {
      const oiRatio = stage.outputBytes / stage.inputBytes;
      if (oiRatio > thresholds.oiRatioMax) {
        out.push({
          type: 'stageShape', stageId: stage.id, impactBand: 'info',
          rule: 'dataExplosion', metric: 'oiRatio', value: Math.round(oiRatio * 10) / 10,
          recommendation: `This stage outputs ${Math.round(oiRatio)}× its input volume: check for an exploding join or a cross product.`,
        });
      }
    }
    // TaskStageSkew: one straggler sets when the stage ends. A task runs inside its stage's
    // window, so the longest task's share of the stage's wall-clock is at most 1. Skip a
    // zero-length or single-task stage. Always info like its siblings: skew and straggler
    // already make the wall-clock claim for the same tail, so this one reports idle core-time.
    if (stageDurationMs > 0 && stage.taskCount > 1 && stage.taskDurationP50 > 0
      && !stageBelowRuntimeFloor(stage, ctx, thresholds.taskStageSkewFloorPct)) {
      const share = stage.taskDurationMax / stageDurationMs;
      const vsMedian = stage.taskDurationMax / stage.taskDurationP50;
      if (share > thresholds.stageShareMin && vsMedian > thresholds.skewWarn) {
        out.push({
          type: 'stageShape', stageId: stage.id, impactBand: 'info',
          rule: 'taskStageSkew', metric: 'taskStageSkew', value: Math.round(share * 100) / 100,
          // Absolute core count, for the impact estimator's idle-core-ms figure.
          totalCores,
          recommendation: `The longest task ran for ${Math.round(share * 100)}% of this stage's wall-clock, ${Math.round(vsMedian * 10) / 10}× the median task: a single straggler is gating the whole stage.`,
        });
      }
    }
    return out;
  },
  estimate(finding, ctx): ImpactEstimate | null {
    const stage = ctx.stages.get(finding.stageId as number);
    if (!stage) return null;
    if (finding.rule === 'lowParallelism') {
      const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
      const idleCoreMs =
        Math.max(0, ((finding.totalCores as number | undefined) ?? 0) - (stage.taskCount ?? 0)) * stageDurationMs;
      // Real per-stage data (cores, task count, duration), no assumed constant.
      return costOnly('measured', { value: idleCoreMs, unit: 'coreMs', idle: true });
    }
    if (finding.rule === 'dataExplosion') {
      const excessBytes = Math.max(0, (stage.outputBytes ?? 0) - (stage.inputBytes ?? 0));
      // Measured input/output byte counts, no assumed constant.
      return costOnly('measured', { value: excessBytes, unit: 'bytes' });
    }
    if (finding.rule === 'taskStageSkew') {
      const totalCores = (finding.totalCores as number | undefined) ?? 0;
      const taskCount = stage.taskCount ?? 0;
      // Cores idle during the straggler's tail, at achieved concurrency (not full cluster
      // capacity, which is lowParallelism's territory): resourceOnly, since skew and straggler
      // already claim that tail's wall-clock time.
      const tailIdleCoreMs =
        Math.max(0, Math.min(totalCores, taskCount) - 1) *
        Math.max(0, (stage.taskDurationMax ?? 0) - (stage.taskDurationP50 ?? 0));
      // An upper bound that assumes every executor stays allocated through the tail, so it is
      // modeled; one stage cannot idle more than the whole run did, so it is clipped to that.
      const idleCoreMs = ctx.runIdleCoreMs == null ? tailIdleCoreMs : Math.min(tailIdleCoreMs, ctx.runIdleCoreMs);
      return costOnly('modeled', { value: idleCoreMs, unit: 'coreMs', idle: true });
    }
    return null;
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  stageShape: { finding: StageShapeFinding; evidence: StageShapeEvidence };
}

export const detectors = [stageShapeDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  stageShape: ['rule'],
} as const satisfies {
  stageShape: readonly AllKeys<StageShapeEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  stageShape: ['rule'],
} as const satisfies {
  stageShape: readonly (DiscriminatorSlot & AllKeys<FindingOf<'stageShape'>>)[];
};
