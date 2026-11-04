import { TAIL_CLAIM, costOnly, singleStageImpact, tasksMostlyIdle } from '../../impact-model.ts';
import { decreaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { defineStageDetector } from '../define.ts';
import { slowShuffleFix, stageReads } from '../partition.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys, StageReads } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface StageSlownessEvidence {
  // What the stage reads, which decides the fix: a shuffle, input files, or neither.
  reads?: StageReads;
}

export interface StageSlownessFinding extends NumericFinding<'stageSlowness'>, StageSlownessEvidence {}

export const stageSlownessDetector = defineStageDetector({
  type: 'stageSlowness', order: 65, bandPolicy: 'derived', fixEffort: 'code', version: 2,
  emits: ['stageSlowness'],
  docAnchor: '#bottleneck-stage-slowness',
  thresholds: { infoMin: 15 },
  // A stage slowHost already explains needs no generic "this stage is slow" finding on top.
  suppressedBy: 'slowHost',
  detect(stage, ctx, thresholds): Finding | null {
    // Basis is real wall-clock stage duration, not per-executor average; the impact-estimator
    // formula reuses this exact stageDurationMs computation.
    const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
    if (!(stageDurationMs > 0)) return null;
    const durationMinutes = stageDurationMs / 60000;
    const t = thresholds;
    const impactBand = durationMinutes >= t.infoMin ? 'info' : null;
    if (!impactBand) return null;
    const value = Math.round(durationMinutes * 10) / 10;
    // A shuffle's reduce-side partition count is the remedy on a stage that reads a shuffle; a stage
    // that reads input files gets the input-partitioning remedy instead.
    const reads = stageReads(stage);
    const shuffleFix = reads === 'shuffle' ? slowShuffleFix(stage, ctx) : null;
    const recommendation = shuffleFix
      ? `This stage ran ${value} minutes with no more specific cause flagged: often a partition-count problem, ${shuffleFix.text}, or check for a large per-task data volume driving heavy shuffle and spill.`
      : reads === 'input'
        ? `This stage ran ${value} minutes with no more specific cause flagged and reads mostly input files: often too few or too uneven input partitions, so check input file sizes and lower spark.sql.files.maxPartitionBytes, or look for a large per-task data volume driving heavy spill.`
        : `This stage ran ${value} minutes with no more specific cause flagged and reads neither shuffle nor input files: check what it computes and for a large per-task data volume driving heavy spill.`;
    return {
      type: 'stageSlowness', stageId: stage.id, impactBand,
      metric: 'stageDurationMinutes', value, reads,
      recommendation,
      remediation: shuffleFix
        ? shuffleFix.remediation
        : reads === 'input' ? [decreaseConf('spark.sql.files.maxPartitionBytes')] : [],
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    // The recommended fix is more partitions, which only helps a stage that ran fewer tasks than
    // the cluster has cores: the time its tasks were running could then spread over up to
    // totalCores (lowShuffleParallelism's shape). Time the stage sat open with no task running
    // is queueing no partition count recovers. Splitting partitions splits the longest task
    // too, hence TAIL_CLAIM's post-fix floor. Unknown cluster size: no defensible figure.
    if (ctx.totalCores <= 0) return costOnly('modeled');
    // A stage that read no input and no shuffle, its tasks idle waiting on an external system,
    // gains nothing from more partitions: claim 0. Stages that read bytes keep their claim.
    const readBytes = (stage.inputBytes ?? 0) + (stage.shuffleReadBytes ?? 0);
    const activeMs = typeof stage.taskActiveMs === 'number'
      ? stage.taskActiveMs
      : Math.max(0, (stage.completedAt ?? 0) - (stage.submittedAt ?? 0));
    const taskCount = stage.taskCount ?? 0;
    const wasteMs = readBytes <= 0 && tasksMostlyIdle(stage, ctx.sql) ? 0 : activeMs * Math.max(0, 1 - taskCount / ctx.totalCores);
    return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', { value: wasteMs, unit: 'ms' }, TAIL_CLAIM);
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  stageSlowness: { finding: StageSlownessFinding; evidence: StageSlownessEvidence };
}

export const detectors = [stageSlownessDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  stageSlowness: ['reads'],
} as const satisfies {
  stageSlowness: readonly AllKeys<StageSlownessEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  stageSlowness: [],
} as const satisfies {
  stageSlowness: readonly (DiscriminatorSlot & AllKeys<FindingOf<'stageSlowness'>>)[];
};
