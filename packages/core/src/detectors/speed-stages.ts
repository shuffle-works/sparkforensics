import { clipAtWord, formatBytes } from '../format-utils.ts';
import { executorHeapPeaks } from '../executor-peaks.ts';
import {
  IDEAL_BYTES_PER_PARTITION_TASK, SHUFFLE_THROUGHPUT_BPS, SPILL_IO_THROUGHPUT_BPS, SPILL_TASK_TIME_SHARE_MAX,
  SPILL_TASK_TIME_SHARE_PER_PASS, TAIL_CLAIM, spillTaskTimeShare, TASK_SCHEDULING_OVERHEAD_MS, costOnly,
  fetchWaitWallClockMs, measuredTaskOverhead, ioModelAssumption, singleStageImpact, stageIoParallelism, tasksMostlyIdle,
  withAssumptions,
} from '../impact-model.ts';
import { attributeSpill, describeSpillCause, spillToInputRatio } from '../spill-attribution.ts';
import { codeFix, decreaseConf, increaseConf, setConf } from '../remediation.ts';
import { parseSparkMemoryMB } from '../spark-memory.ts';
import type { Finding, ImpactEstimate } from '../types.ts';
import type { Remediation } from '../finding-types.ts';
import { dynamicAllocationOff, effectiveConf, stageApp } from './conf.ts';
import { gcConfidence } from './confidence.ts';
import { defineAppDetector, defineStageDetector } from './define.ts';
import {
  ADVISORY_PARTITION_SIZE_KEY, aqeAdjustedNote, lowShuffleParallelismFix, parallelismFirstOn, partitionLever,
  shufflePartitionCase, slowShuffleFix, stageReads, tinyShuffleFix,
} from './partition.ts';
import { stageBelowRuntimeFloor } from './runtime-floor.ts';
import { SINGLE_KEY_CAUSE, SINGLE_KEY_REMEDY, skewFix } from './skew-fix.ts';
import type { DetectorCtx, DetectorStage } from './types.ts';
import { GB, MB } from './units.ts';

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

// Whether memoryUtilization can judge the executor heap: a measured peak and a known executor size.
// Without both, the stage-level low-GC note is the only memory-sizing signal there is.
function heapJudgementAvailable(ctx: Pick<DetectorCtx, 'stages' | 'runAggregates' | 'app'>): boolean {
  return executorHeapPeaks(ctx).size > 0 && (ctx.app?.resources?.executor?.memoryMB ?? 0) > 0;
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

// Caveats that name a threshold read it from the thresholds the detector ran with, so a tuned run
// states the floor it actually used.
function gcValidation(minRunTimeMs: number): string {
  return `Checked only on stages with at least ${minRunTimeMs / 1000}s of executor run time.`;
}

export const stageShapeDetector = defineStageDetector({
  type: 'stageShape', order: 35, fixEffort: 'code', version: 2,
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

export const shuffleDetector = defineStageDetector({
  type: 'shuffle', order: 20, fixEffort: 'config', version: 1,
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

export const partitionSizingDetector = defineStageDetector({
  type: 'partitionSizing', order: 22, fixEffort: 'config', version: 1,
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
      // Fixed 'critical': an OOM/crash-risk safety signal, not a time-waste one. Exempted in
      // impact-band.ts's deriveImpactBand from the wall-clock-based overwrite every other
      // finding here gets, so a long-running job can't demote an active crash risk to 'info'
      // just because the modeled time savings are a small fraction of total runtime.
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

export const spillDetector = defineStageDetector({
  type: 'spill', order: 10, fixEffort: 'code', version: 1,
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

export const gcDetector = defineStageDetector({
  type: 'gc', order: 50, fixEffort: 'config', version: 1,
  emits: ['gc'],
  docAnchor: '#bottleneck-gc',
  thresholds: {
    warnPct100: 10,
    // A GC share below this reads as over-provisioned memory (the low-GC note).
    lowInfoPct100: 5,
    // Noise floor so a stage that barely ran doesn't flag either direction.
    minRunTimeMs: 10000,
    // lowInfoFloorPct: the 0.5% runtime floor stageShape's lowParallelism uses. The low-GC note is
    // an app-level memory-sizing signal; on a stage shorter than this share of the run it adds
    // nothing to that call.
    lowInfoFloorPct: 0.005,
  },
  detect(stage, ctx, thresholds): Finding | null {
    const pct = stage.gcPct;
    if ((stage.executorRunTime ?? 0) >= thresholds.minRunTimeMs
        && pct > thresholds.warnPct100) {
      const value = Math.round(pct * 10) / 10;
      return {
        type: 'gc', stageId: stage.id,
        impactBand: 'warning',
        metric: 'gcPct', value,
        confidence: gcConfidence(pct, thresholds, 'high'), validationRequired: gcValidation(thresholds.minRunTimeMs),
        recommendation: `GC consumed ${value}% of executor run time: reduce object creation, use primitive types, avoid UDFs, increase executor memory.`,
        remediation: [increaseConf('spark.executor.memory')],
      };
    }
    // Low-GC (cost) branch: only for stages that ran long enough to be meaningful, and only as
    // the fallback sizing signal: a log with measured executor heap peaks and a known executor
    // memory gets memoryUtilization's heapOverProvisioned judgement instead (low GC time just
    // means a low allocation rate).
    if ((stage.executorRunTime ?? 0) >= thresholds.minRunTimeMs
        && !heapJudgementAvailable(ctx)
        // A stage that failed, or lost tasks, ran too little work to call its GC low.
        && stage.stageFailureReason == null && stage.failedTasks === 0
        && pct < thresholds.lowInfoPct100
        && !stageBelowRuntimeFloor(stage, ctx, thresholds.lowInfoFloorPct)) {
      const value = Math.round(pct * 10) / 10;
      return {
        type: 'gc', stageId: stage.id, direction: 'low',
        impactBand: 'info',
        metric: 'gcPct', value,
        confidence: gcConfidence(pct, thresholds, 'low'), validationRequired: gcValidation(thresholds.minRunTimeMs),
        recommendation: `GC consumed only ${value}% of executor run time: memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.`,
        remediation: [decreaseConf('spark.executor.memory')],
      };
    }
    return null;
  },
  estimate(finding, ctx): ImpactEstimate | null {
    // The low-GC branch is an over-provisioning signal whose fix (less executor memory) raises
    // GC rather than recovering it: the stage's GC time is no saving there, so no waste model.
    if (finding.direction === 'low') return costOnly('none');
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
    const executorRunTime = stage.executorRunTime ?? 0;
    const jvmGCTime = stage.jvmGCTime ?? 0;
    // The raw cross-task core-time sum, before any conversion: the one figure here
    // that is straight from the log rather than modeled.
    const rawWaste = { value: jvmGCTime, unit: 'coreMs' } as const;
    if (executorRunTime <= 0 || stageDurationMs <= 0) {
      return costOnly('modeled', rawWaste);
    }
    const avgConcurrency = executorRunTime / stageDurationMs;
    // jvmGCTime is a cross-task core-time sum (same shape as executorRunTime); dividing by the
    // stage's average concurrency converts it to an approximate wall-clock figure. Modeled, not exact.
    const wasteMs = jvmGCTime / avgConcurrency;
    return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', rawWaste);
  },
});

export const stageSlownessDetector = defineStageDetector({
  type: 'stageSlowness', order: 65, fixEffort: 'code', version: 2,
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

export const tinyTaskDetector = defineStageDetector({
  type: 'tinyTask', order: 80, fixEffort: 'code', version: 1,
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

export const coldStartDetector = defineAppDetector({
  type: 'coldStart', order: 90, fixEffort: 'code', version: 1,
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
