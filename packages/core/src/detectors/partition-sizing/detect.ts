import { formatBytes } from '../../units.ts';
import { IDEAL_BYTES_PER_PARTITION_TASK, SHUFFLE_THROUGHPUT_BPS, TAIL_CLAIM, singleStageImpact } from '../../impact-model.ts';
import { codeFix } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { defineStageDetector } from '../define.ts';
import { lowShuffleParallelismFix } from '../partition.ts';
import { SINGLE_KEY_CAUSE, SINGLE_KEY_REMEDY, skewFix } from '../skew-fix.ts';
import { GB, MB } from '../units.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys, SkewOrigin, AqeSkewCase, ShufflePartitions } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface PartitionSizingEvidence {
  rule: 'shufflePartitionSkew' | 'lowShuffleParallelism' | 'maxPartitionTooBig';
  // Only on 'shufflePartitionSkew': see SkewOrigin and AqeSkewCase.
  origin?: SkewOrigin;
  aqeSkew?: AqeSkewCase;
  // Only on 'shufflePartitionSkew': true when the median partition is empty and one partition holds
  // nearly all the stage's shuffle read, so one key carries the shuffle.
  singleKey?: true;
  // Only on 'lowShuffleParallelism': see ShufflePartitions ('raise', 'aqeCoalesced' or 'ownPartitioning').
  partitions?: ShufflePartitions;
}

export interface PartitionSizingFinding extends NumericFinding<'partitionSizing'>, PartitionSizingEvidence {}

export const partitionSizingDetector = defineStageDetector({
  type: 'partitionSizing', order: 22, bandPolicy: 'derived', fixEffort: 'config', version: 1,
  // maxPartitionTooBig is an OOM/crash-risk safety signal, not a time-recovery one: it stays critical
  // however little wall-clock fixing it saves.
  gradeAs: (finding) => (finding.rule === 'maxPartitionTooBig' ? 'failure' : 'derived'),
  emits: ['partitionSizing'],
  docAnchor: '#bottleneck-partition-sizing',
  thresholds: { skewRatio: 5, skewFloorBytes: 256 * MB, singleKeyShare: 0.9, lowParTotalBytes: GB, lowParMaxTasks: 7, maxPartBytes: 5 * GB },
  detect(stage, ctx, thresholds): Finding[] {
    const out: Finding[] = [];
    const { shuffleReadP50: p50, shuffleReadMax: max, shuffleReadBytes: total, taskCount } = stage;
    if (max > thresholds.skewRatio * p50 && max > thresholds.skewFloorBytes) {
      // One task reading nearly the whole shuffle while the median reads nothing: more partitions
      // or AQE splitting cannot divide a single key, so the advice is about the key itself.
      const singleKey = p50 === 0 && max >= thresholds.singleKeyShare * total;
      // p50 can be 0 (over half the shuffle partitions empty): a ratio against zero renders
      // "Infinity×", so fall back to median-free phrasing.
      const ratioText = p50 > 0
        ? `${Math.round(max / p50 * 10) / 10}× the median (${formatBytes(p50)})`
        : 'far larger than the median, which is effectively empty';
      const fix = skewFix(stage, ctx, true);
      out.push({
        type: 'partitionSizing', stageId: stage.id, impactBand: 'warning',
        rule: 'shufflePartitionSkew', origin: fix.origin, aqeSkew: fix.aqeSkew, metric: 'shuffleReadMax', value: max,
        ...(singleKey ? { singleKey } : {}),
        recommendation: singleKey
          ? `The largest shuffle partition (${formatBytes(max)}) holds ${Math.round(max / total * 100)}% of the stage's shuffle read and the median partition is empty: ${SINGLE_KEY_CAUSE}.`
          : `The largest shuffle partition (${formatBytes(max)}) is ${ratioText}: ${fix.text}.`,
        remediation: singleKey ? [codeFix(SINGLE_KEY_REMEDY)] : fix.remediation,
      });
    }
    if (total >= thresholds.lowParTotalBytes && taskCount <= thresholds.lowParMaxTasks) {
      const fix = lowShuffleParallelismFix(stage, ctx);
      out.push({
        type: 'partitionSizing', stageId: stage.id, impactBand: 'warning',
        rule: 'lowShuffleParallelism', partitions: fix.partitions, metric: 'taskCount', value: taskCount,
        recommendation: `${Math.round(total / GB * 10) / 10} GB of shuffle spread over only ${taskCount} tasks: ${fix.text}.`,
        remediation: fix.remediation,
      });
    }
    if (max >= thresholds.maxPartBytes) {
      // Fixed 'critical': an OOM/crash-risk safety signal, not a time-waste one. This entry's
      // `gradeAs` keeps it out of the wall-clock grading every other finding here gets, so a
      // long-running job can't demote an active crash risk to 'info' just because the modeled
      // time savings are a small fraction of total runtime.
      out.push({
        type: 'partitionSizing', stageId: stage.id, impactBand: 'critical',
        rule: 'maxPartitionTooBig', metric: 'shuffleReadMax', value: max,
        recommendation: `A single shuffle partition (${formatBytes(max)}) exceeds 5 GB: this will OOM or spill heavily. Repartition to break it up before this stage.`,
      });
    }
    return out;
  },
  estimate(finding, ctx): ImpactEstimate | null {
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    let wasteMs = 0;
    let longestTaskAfterFixMs = 0;
    if (finding.rule === 'maxPartitionTooBig') {
      wasteMs = ((stage.shuffleReadMax ?? 0) / SHUFFLE_THROUGHPUT_BPS) * 1000;
    } else if (finding.rule === 'shufflePartitionSkew') {
      const delta = Math.max(0, (stage.shuffleReadMax ?? 0) - (stage.shuffleReadP50 ?? 0));
      wasteMs = (delta / SHUFFLE_THROUGHPUT_BPS) * 1000;
    } else if (finding.rule === 'lowShuffleParallelism') {
      const targetTaskCount = Math.ceil((stage.shuffleReadBytes ?? 0) / IDEAL_BYTES_PER_PARTITION_TASK);
      const taskCount = stage.taskCount ?? 0;
      if (targetTaskCount > taskCount && taskCount > 0) {
        const stageDurationMs = Math.max(0, (stage.completedAt ?? 0) - (stage.submittedAt ?? 0));
        // Too few shuffle partitions means each task processes more than the ideal bytes,
        // serializing work more partitions would run concurrently: the waste is that serialized
        // work, not the scheduling cost of tasks you'd add (adding tasks incurs overhead, recovers
        // nothing). Model the achievable duration at target parallelism by scaling down proportionally.
        wasteMs = stageDurationMs * (1 - taskCount / targetTaskCount);
        // The fix splits the long tasks, so the longest task is the quantity it shortens: the
        // occupancy clip must not floor the claim at it (TAIL_CLAIM). An even split leaves the
        // longest task at taskCount / targetTaskCount of today's: a modeled figure.
        const longestTaskMs = stage.taskDurationMax ?? 0;
        longestTaskAfterFixMs = longestTaskMs * taskCount / targetTaskCount;
        // Splitting only shortens tasks: the stage still takes the time outside its longest task
        // plus the longest task the split leaves, so the claim is at most the longest task's own
        // reduction. Without a task-duration max (older snapshots) the stage-wide scaling stands.
        if (longestTaskMs > 0) wasteMs = Math.min(wasteMs, longestTaskMs - longestTaskAfterFixMs);
      }
    } else {
      return null;
    }
    return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', { value: wasteMs, unit: 'ms' },
      finding.rule === 'lowShuffleParallelism' ? { ...TAIL_CLAIM, longestTaskAfterFixMs } : undefined);
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  partitionSizing: { finding: PartitionSizingFinding; evidence: PartitionSizingEvidence };
}

export const detectors = [partitionSizingDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  partitionSizing: ['rule', 'origin', 'aqeSkew', 'singleKey', 'partitions'],
} as const satisfies {
  partitionSizing: readonly AllKeys<PartitionSizingEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  partitionSizing: ['rule'],
} as const satisfies {
  partitionSizing: readonly (DiscriminatorSlot & AllKeys<FindingOf<'partitionSizing'>>)[];
};
