import { formatBytes } from '../../units.ts';
import {
  SHUFFLE_THROUGHPUT_BPS, fetchWaitWallClockMs, ioModelAssumption, singleStageImpact, stageIoParallelism, withAssumptions,
} from '../../impact-model.ts';
import { decreaseConf, increaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { defineStageDetector } from '../define.ts';
import { ADVISORY_PARTITION_SIZE_KEY, shufflePartitionCase } from '../partition.ts';
import { stageBelowRuntimeFloor } from '../runtime-floor.ts';
import { MB } from '../units.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys, ShufflePartitions } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface ShuffleEvidence {
  partitions?: ShufflePartitions;
}

export interface ShuffleFinding extends NumericFinding<'shuffle'>, ShuffleEvidence {}

export const shuffleDetector = defineStageDetector({
  type: 'shuffle', order: 20, bandPolicy: 'derived', fixEffort: 'config', version: 1,
  emits: ['shuffle'],
  docAnchor: '#bottleneck-shuffle',
  // stageFloorPct: the 0.5% runtime floor. The shuffle claim is clipped to the stage, so on a
  // shorter stage it would grade info; the shuffle is still there, the floor drops the finding.
  thresholds: { minBytes: 50 * MB, stageFloorPct: 0.005 },
  detect(stage, ctx, thresholds): Finding | null {
    const bytes = stage.shuffleReadBytes;
    if (bytes <= thresholds.minBytes) return null;
    if (stageBelowRuntimeFloor(stage, ctx, thresholds.stageFloorPct)) return null;
    const { partitions, count, key } = shufflePartitionCase(stage, ctx);
    const perTask = formatBytes(bytes / Math.max(1, stage.taskCount));
    const fix = partitions === 'sufficient'
      ? { text: `its ${stage.taskCount} tasks already read about ${perTask} each, so more partitions will not help: consider a broadcast join for the smaller side`, remediation: [] }
      : partitions === 'aqeCoalesced'
        ? { text: `AQE coalesced it into ${stage.taskCount} tasks (from ${count} configured partitions): consider lowering ${ADVISORY_PARTITION_SIZE_KEY} or adding a broadcast join`, remediation: [decreaseConf(ADVISORY_PARTITION_SIZE_KEY)] }
        : partitions === 'ownPartitioning'
          ? { text: `${key} (${count}) did not size this stage's ${stage.taskCount} tasks, so consider raising its own partition count (its repartition(n) or RDD parallelism) or adding a broadcast join`, remediation: [] }
          : { text: `consider increasing ${key} or adding a broadcast join`, remediation: [increaseConf(key)] };
    return {
      type: 'shuffle', stageId: stage.id,
      impactBand: 'info', partitions,
      metric: 'shuffleReadBytes', value: bytes,
      recommendation: `${formatBytes(bytes)} shuffled in this stage: ${fix.text}.`,
      remediation: fix.remediation,
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const shuffleReadBytes = stage.shuffleReadBytes ?? 0;
    const modeledMs = (shuffleReadBytes / (SHUFFLE_THROUGHPUT_BPS * stageIoParallelism(stage))) * 1000;
    // The link model can't see whether the reads stalled the tasks: capped at the fetch wait the
    // tasks measured, the claim never exceeds what the stage spent blocked on the network.
    const measuredMs = fetchWaitWallClockMs(stage);
    const wasteMs = measuredMs == null ? modeledMs : Math.min(modeledMs, measuredMs);
    // rawWaste: the measured byte volume behind the modeled figure.
    const capped = measuredMs != null && measuredMs < modeledMs;
    return withAssumptions(
      singleStageImpact(wasteMs, finding.stageId, ctx, capped ? 'measured' : 'modeled', { value: shuffleReadBytes, unit: 'bytes' }),
      `${ioModelAssumption(SHUFFLE_THROUGHPUT_BPS, stage)}; counts network transfer only${capped ? ', capped at the fetch wait the tasks measured' : ''}`,
    );
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  shuffle: { finding: ShuffleFinding; evidence: ShuffleEvidence };
}

export declare const emits: Emits;

export const detectors = [shuffleDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  shuffle: ['partitions'],
} as const satisfies {
  shuffle: readonly AllKeys<ShuffleEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  shuffle: [],
} as const satisfies {
  shuffle: readonly (DiscriminatorSlot & AllKeys<FindingOf<'shuffle'>>)[];
};
