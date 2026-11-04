import { clipAtWord } from '../../text-format.ts';
import { formatBytes } from '../../units.ts';
import {
  IDEAL_BYTES_PER_PARTITION_TASK, SPILL_IO_THROUGHPUT_BPS, SPILL_TASK_TIME_SHARE_MAX, SPILL_TASK_TIME_SHARE_PER_PASS, spillTaskTimeShare, ioModelAssumption, singleStageImpact, stageIoParallelism, withAssumptions,
} from '../../impact-model.ts';
import { attributeSpill, describeSpillCause, spillToInputRatio } from '../../spill-attribution.ts';
import { codeFix, decreaseConf, increaseConf, setConf } from '../../remediation.ts';
import { parseSparkMemoryMB } from '../../spark-memory.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import type { Remediation, AllKeys, StageReads } from '../../finding-types.ts';
import { effectiveConf, stageApp } from '../conf.ts';
import { defineStageDetector } from '../define.ts';
import { ADVISORY_PARTITION_SIZE_KEY, aqeAdjustedNote, parallelismFirstOn, partitionLever, stageReads } from '../partition.ts';
import { stageBelowRuntimeFloor } from '../runtime-floor.ts';
import type { DetectorCtx, DetectorStage } from '../types.ts';
import { GB, MB } from '../units.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

/** An operator of the spilling stage with the "spill size" the plan reports for it. A Sort under a
 * SortMergeJoin names it in `feeds`. */
export interface SpillOperator {
  nodeId: string;
  name: string;
  spillBytes: number;
  feeds?: string;
  // The operator's plan arguments (a Sort's keys, an aggregate's keys and functions), cut at a word near 300 characters.
  arguments?: string;
  // Sort only: true for a global sort (ORDER BY), false for one within each partition.
  global?: boolean;
}

/** The columns of an exchange's rows and their estimated bytes per row ("data size" over shuffle
 * records written). Each is absent when unknown. */
export interface ExchangeWidth {
  columns?: number;
  bytesPerRow?: number;
}

/** The width of an exchange an operator reads from, with its read half's plan node id. */
export interface SpillExchange extends ExchangeWidth {
  nodeId: string;
  // The partitioning as the plan prints it (`hashpartitioning(k#1, 200)`) and its partition count.
  partitioning?: string;
  partitions?: number;
  // Why Spark planned the shuffle. REPARTITION_BY_NUM is the job's own repartition(n), so
  // spark.sql.shuffle.partitions does not change its count.
  origin?: string;
}

export interface SpillEvidence {
  spillMagnitude?: 'severe' | 'high' | 'medium';
  // What the stage reads: shuffle-partition advice applies only to 'shuffle'.
  reads?: StageReads;
  // Memory spill over the stage's input plus shuffle read; absent when that input is small.
  spillToInputRatio?: number;
  // Set with the ratio: true from 10x, which means the rows are wide.
  wideRows?: boolean;
  // Up to five operators that report a spill size, largest first.
  operators?: SpillOperator[];
  // The exchanges those operators read.
  exchanges?: SpillExchange[];
  // Description of the SQL execution the stage belongs to, cut at a word near 200 characters.
  sqlDescription?: string;
}

export interface SpillFinding extends NumericFinding<'spill'>, SpillEvidence {}

interface SpillThresholds {
  singleTaskDiskGiB: number; singleTaskMemGiB: number;
  highDiskGiB: number; highTaskDiskMB: number; highMemGiB: number;
  medDiskMB: number; medMemGiB: number;
  skewRatio: number; skewDiskFloorMB: number; skewMemFloorMB: number; skewMinTasks: number;
  stageFloorPct: number;
}

// Spill magnitude: absolute-volume tiers first, then ratio-plus-floor skew tiers.
function computeSpillMagnitude(
  stage: Pick<DetectorStage, 'taskCount' | 'spillDiskMax' | 'spillMemMax' | 'spillDiskP50' | 'spillMemP50'>,
  t: SpillThresholds,
): { magnitude: 'severe' | 'high' | 'medium' } | null {
  const { taskCount, spillDiskMax = 0, spillMemMax = 0, spillDiskP50 = 0, spillMemP50 = 0 } = stage;
  // Absolute volume, branching on task count.
  if (taskCount === 1) {
    if (spillDiskMax >= t.singleTaskDiskGiB * GB || spillMemMax >= t.singleTaskMemGiB * GB) return { magnitude: 'severe' };
  } else {
    const perTaskDisk = taskCount > 0 ? spillDiskMax / taskCount : 0; // approximation: max used as per-task proxy
    if (spillDiskMax >= t.highDiskGiB * GB || perTaskDisk >= t.highTaskDiskMB * MB || spillMemMax >= t.highMemGiB * GB) return { magnitude: 'high' };
    if (spillDiskMax >= t.medDiskMB * MB || spillMemMax >= t.medMemGiB * GB) return { magnitude: 'medium' };
  }
  // Ratio plus floor skew (requires enough tasks).
  if (taskCount >= t.skewMinTasks) {
    if (spillDiskP50 > 0 && spillDiskMax / spillDiskP50 > t.skewRatio && spillDiskMax >= t.skewDiskFloorMB * MB) return { magnitude: 'high' };
    if (spillMemP50 > 0 && spillMemMax / spillMemP50 > t.skewRatio && spillMemMax >= t.skewMemFloorMB * MB) return { magnitude: 'medium' };
  }
  return null;
}

const EXECUTOR_CORES_KEY = 'spark.executor.cores';

const COALESCE_MIN_PARTITIONS_KEY = 'spark.sql.adaptive.coalescePartitions.minPartitionNum';

const MEMORY_FRACTION_KEY = 'spark.memory.fraction';

const DEFAULT_MEMORY_FRACTION = 0.6;

// Spark keeps this much of the executor heap out of its unified memory region (UnifiedMemoryManager).
const RESERVED_MEMORY_BYTES = 300 * MB;

type SpillCoresFix = { text: string; remediation: Remediation[] };

// The lever for a volume spill whose tasks fill their slot: execution memory per task slot is the
// executor's unified region (heap less the reserve, times spark.memory.fraction) over its cores. When
// a task's peak is near that share, halving the cores doubles it. Cores are the logged
// spark.executor.cores, else the one core count every added executor reports. Null in local mode,
// when the cores are unknown or differ between executors, the executor has one core, or the peak is
// well under the share.
function spillCoresFix(stage: DetectorStage, ctx: DetectorCtx, nearShareRatio: number): SpillCoresFix | null {
  const app = ctx.app;
  const reported = new Set(ctx.executorsAdded.map((e) => e.totalCores));
  const cores = app?.resources?.executor?.cores ?? (reported.size === 1 ? [...reported][0] : undefined);
  const memoryMB = parseSparkMemoryMB(effectiveConf(app, 'spark.executor.memory'));
  if (stage.spillClassification !== 'volume' || effectiveConf(app, 'spark.master')?.startsWith('local') || !memoryMB || !cores || cores < 2) return null;
  const fraction = Number.parseFloat(effectiveConf(app, MEMORY_FRACTION_KEY) ?? '');
  const region = (memoryMB * MB - RESERVED_MEMORY_BYTES) * (Number.isFinite(fraction) ? fraction : DEFAULT_MEMORY_FRACTION);
  const share = region / cores;
  const peak = stage.peakExecutionMemoryMax ?? 0;
  if (share <= 0 || peak < nearShareRatio * share) return null;
  const fewer = Math.floor(cores / 2);
  return {
    text: `lower ${EXECUTOR_CORES_KEY} to ${fewer} (each of the ${cores} task slots gets ${formatBytes(share)} of execution memory and a task peaked at ${formatBytes(peak)})`,
    remediation: [decreaseConf(EXECUTOR_CORES_KEY, fewer)],
  };
}

// spill's fix on a stage that reads a shuffle and spills for volume: smaller partitions, fewer cores
// per executor when the tasks fill their memory slot, or more memory. Raising
// spark.sql.shuffle.partitions only helps while the property sized the stage, never when the stage
// reads the job's own repartition(n) (`userPartitioned`), whatever its count.
function spillShuffleFix(stage: DetectorStage, ctx: DetectorCtx, userPartitioned: boolean, cores: SpillCoresFix | null): { text: string; remediation: Remediation[] } {
  const memory = increaseConf('spark.executor.memory');
  const coresText = cores ? `, ${cores.text}` : '';
  const coresRemediation = cores?.remediation ?? [];
  const needed = Math.ceil(stage.shuffleReadBytes / IDEAL_BYTES_PER_PARTITION_TASK);
  if (userPartitioned) {
    const hint = "raise the partition count of the job's own repartition(n) so each partition is smaller";
    return { text: `${hint}${coresText}, or increase executor memory`, remediation: [codeFix(hint), ...coresRemediation, memory] };
  }
  const { lever, count, key, explicitRepartition } = partitionLever(stage, ctx);
  if (lever === 'aqeCoalesced') {
    const raisesCount = cores != null && count != null && needed > count;
    const raisesFloor = cores != null && !raisesCount && needed > stage.taskCount && parallelismFirstOn(stageApp(ctx, stage));
    return {
      text: `AQE coalesced the ${count} configured shuffle partitions into ${stage.taskCount} tasks: lower ${ADVISORY_PARTITION_SIZE_KEY} so each partition is smaller${raisesFloor ? `, set ${COALESCE_MIN_PARTITIONS_KEY} to ${needed}` : ''}${raisesCount ? `, raise ${key} to ${needed}` : ''}${coresText}, or increase executor memory`,
      remediation: [
        decreaseConf(ADVISORY_PARTITION_SIZE_KEY),
        ...(raisesFloor ? [setConf(COALESCE_MIN_PARTITIONS_KEY, needed)] : []),
        ...(raisesCount ? [increaseConf(key, needed)] : []),
        ...coresRemediation,
        memory,
      ],
    };
  }
  if (lever === 'ownPartitioning') {
    const hint = "raise this stage's own partition count (its repartition(n) or RDD parallelism) so each partition is smaller";
    return { text: `the configured shuffle partition count is ${count} but this stage ran ${stage.taskCount} tasks, so ${hint}${coresText}, or increase executor memory`, remediation: [codeFix(hint), ...coresRemediation, memory] };
  }
  const note = lever === 'aqeAdjusted' ? aqeAdjustedNote(stage, count, explicitRepartition) : '';
  const sized = cores != null && count != null && needed > count;
  return {
    text: `raise ${key}${sized ? ` to ${needed}` : ''}${coresText} or increase executor memory${note}`,
    remediation: [increaseConf(key, sized ? needed : null), ...coresRemediation, memory],
  };
}

export const spillDetector = defineStageDetector({
  type: 'spill', order: 10, bandPolicy: 'derived', fixEffort: 'code', version: 1,
  emits: ['spill'],
  docAnchor: '#bottleneck-spill',
  // stageFloorPct: the 0.5% runtime floor, as for shuffle.
  thresholds: { singleTaskDiskGiB: 1, singleTaskMemGiB: 4, highDiskGiB: 1, highTaskDiskMB: 512, highMemGiB: 4, medDiskMB: 256, medMemGiB: 1, skewRatio: 5, skewDiskFloorMB: 128, skewMemFloorMB: 256, skewMinTasks: 10, stageFloorPct: 0.005,
    // The spill-to-input ratio from which rows are called wide, and the input below which it is not reported.
    wideRowRatio: 10, wideRowMinInputMB: 64,
    // The share of a task slot's execution memory a task's peak must reach for the cores lever.
    peakNearShareRatio: 0.8 },
  detect(stage, ctx, thresholds): Finding | null {
    if (stage.memoryBytesSpilled === 0) return null;
    if (stageBelowRuntimeFloor(stage, ctx, thresholds.stageFloorPct)) return null;
    const cls = stage.spillClassification;
    const classified = cls === 'skew' || cls === 'volume';
    const mag = computeSpillMagnitude(stage, thresholds);
    const impactBand = 'warning';
    // shuffle.partitions sizes a shuffle's reduce side: a stage that reads no shuffle gets memory only.
    const reads = stageReads(stage);
    const execution = stage.sqlExecutionId != null ? ctx.sql.get(stage.sqlExecutionId) : undefined;
    const { operators, exchanges } = attributeSpill(execution?.planTree, stage.id);
    const cores = spillCoresFix(stage, ctx, thresholds.peakNearShareRatio);
    const shuffleFix = reads === 'shuffle' ? spillShuffleFix(stage, ctx, exchanges[0]?.origin === 'REPARTITION_BY_NUM', cores) : null;
    const ratio = spillToInputRatio(stage.memoryBytesSpilled, stage.inputBytes, stage.shuffleReadBytes, thresholds.wideRowMinInputMB * MB);
    const wide = ratio !== null && ratio >= thresholds.wideRowRatio;
    const advice = cls === 'skew'
      ? `${formatBytes(stage.memoryBytesSpilled)} spilled, skew-driven: fix task skew first; adding memory will not help.`
      : shuffleFix
        ? `${formatBytes(stage.memoryBytesSpilled)} spilled: ${shuffleFix.text}.`
        : `${formatBytes(stage.memoryBytesSpilled)} spilled: this stage reads no shuffle, so ${cores ? `${cores.text}, increase executor memory, or` : 'increase executor memory or'} process less data per task.`;
    const cause = describeSpillCause(operators, ratio, wide, reads === 'input', exchanges[0]);
    const sqlDescription = clipAtWord(execution?.description?.trim() ?? '', 200);
    return {
      type: 'spill', stageId: stage.id, impactBand, reads,
      spillMagnitude: mag?.magnitude,
      ...(ratio !== null ? { spillToInputRatio: ratio, wideRows: wide } : {}),
      ...(operators.length > 0 ? { operators } : {}),
      ...(exchanges.length > 0 ? { exchanges } : {}),
      ...(sqlDescription ? { sqlDescription } : {}),
      metric: 'memoryBytesSpilled', value: stage.memoryBytesSpilled,
      confidence: classified ? 'medium' : 'low',
      validationRequired: classified
        ? 'Spill cause is inferred from the share of tasks that spilled: confirm against per-task spill metrics in the Spark UI.'
        : 'Spill cause could not be classified: inspect per-task spill metrics in the Spark UI before acting.',
      recommendation: cause ? `${advice} ${cause}` : advice,
      remediation: cls === 'skew' ? [] : shuffleFix?.remediation ?? [...(cores?.remediation ?? []), increaseConf('spark.executor.memory')],
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const diskBytesSpilled = stage.diskBytesSpilled ?? 0;
    const ioMs = (diskBytesSpilled / (SPILL_IO_THROUGHPUT_BPS * stageIoParallelism(stage))) * 1000;
    // The same share of task time is the same share of the stage's duration at constant concurrency.
    const cpuShare = spillTaskTimeShare(stage);
    const durationMs = Math.max(0, (stage.completedAt ?? 0) - (stage.submittedAt ?? 0));
    const wasteMs = ioMs + durationMs * (cpuShare ?? 0);
    const cpuAssumption = cpuShare === null
      ? `${diskBytesSpilled > 0 ? 'the stage read no bytes to compare its disk spill to' : 'the stage spilled nothing to disk'}, so serialization and sort CPU is not counted`
      : `plus ${Math.round(cpuShare * 100)}% of the stage's task time as serialization and sort CPU (${SPILL_TASK_TIME_SHARE_PER_PASS * 100}% per pass of its read bytes through disk spill, capped at ${SPILL_TASK_TIME_SHARE_MAX * 100}%)`;
    // The sort CPU is part of the core work, so removing it lowers the stage's core-work floor too.
    const removedCoreWorkMs = (stage.executorRunTime ?? 0) * (cpuShare ?? 0);
    // The displayed metric is memoryBytesSpilled; the raw figure is the disk bytes that cost the I/O time.
    const estimate = singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', { value: diskBytesSpilled, unit: 'bytes' },
      { removedCoreWorkMs });
    return withAssumptions(
      removedCoreWorkMs > 0 ? { ...estimate, coreTimeMs: { low: removedCoreWorkMs, high: removedCoreWorkMs } } : estimate,
      `${ioModelAssumption(SPILL_IO_THROUGHPUT_BPS, stage)} for disk spill, ${cpuAssumption}; GC is not counted`,
    );
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  spill: { finding: SpillFinding; evidence: SpillEvidence };
}

export declare const emits: Emits;

export const detectors = [spillDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  spill: ['spillMagnitude', 'reads', 'spillToInputRatio', 'wideRows', 'operators', 'exchanges', 'sqlDescription'],
} as const satisfies {
  spill: readonly AllKeys<SpillEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  spill: [],
} as const satisfies {
  spill: readonly (DiscriminatorSlot & AllKeys<FindingOf<'spill'>>)[];
};
