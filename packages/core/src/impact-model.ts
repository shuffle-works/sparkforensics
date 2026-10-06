// The waste models every detector entry's estimate() builds its ImpactEstimate from: the assumed
// throughputs, the per-stage measurements behind them and the occupancy clip wrappers. Each
// finding type's own composition of these lives on its DETECTORS entry, next to its detect().
import type { Finding, ImpactEstimate, ImpactEstimateMethod, RawWasteFigure, SqlExecution, Stage } from './types.ts';
import { isPythonStage } from './python-stage.ts';
import { nsToMs } from './format-utils.ts';
import {
  estimateSingleStage, estimateMultiStage,
  type OccupancyStage, type SingleStageEstimateOptions, type StageOccupancyInfo,
} from './occupancy.ts';

/** What every estimate() is handed: built once per analyze(), and the same object detect() gates
 * its runtime floors against (DetectorCtx.impact), so a floor and the savings displayed for it
 * read one occupancy sweep. */
export interface EstimateCtx {
  stages: Map<number, Stage>;
  occupancy: Map<number, StageOccupancyInfo>;
  // Peak concurrent cores (computePeakConcurrentCores); 0 when no executor data.
  totalCores: number;
  // The run's SQL executions, for the plan nodes behind isPythonStage. Absent on hand-built ctxs.
  sql?: Map<number, SqlExecution>;
}

// Assumed shuffle-network throughput per executor link, ~1 Gbps. Starting assumption, unvalidated.
export const SHUFFLE_THROUGHPUT_BPS = 125_000_000;
// Assumed disk I/O throughput per executor for spilled data, ~200 MB/s (conservative HDD/SSD blend).
export const SPILL_IO_THROUGHPUT_BPS = 200_000_000;

// A stage's own per-task overhead: task wall time (launch to finish, summed per executor by
// finalizeStage) minus executorRunTime, i.e. deserialization, result serialization and the
// launch round trip that coalescing tasks removes. `concurrency` is the stage's achieved task
// concurrency (task time / stage duration). Null when the stage has no such data or no overhead.
export function measuredTaskOverhead(stage: Stage): { perTaskMs: number; concurrency: number } | null {
  const executorStats = Array.isArray(stage.executorStats)
    ? (stage.executorStats as { totalDuration?: number }[]) : [];
  const taskTimeMs = executorStats.reduce((sum, e) => sum + (e.totalDuration ?? 0), 0);
  const taskCount = stage.taskCount ?? 0;
  const durationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  const overheadMs = taskTimeMs - (stage.executorRunTime ?? 0);
  if (taskTimeMs <= 0 || taskCount <= 0 || durationMs <= 0 || overheadMs <= 0) return null;
  return { perTaskMs: overheadMs / taskCount, concurrency: taskTimeMs / durationMs };
}

// Both constants above are single-device figures (one NIC, one local disk). A stage's shuffle
// reads and spills are spread over every executor that ran its tasks, each moving its own share
// in parallel, so the stage's aggregate bandwidth scales with that executor count. Dividing a
// stage-wide byte total by one device's bandwidth modeled the whole cluster as one link: on 14
// real logs that claimed up to 1,870s of shuffle time on stages whose tasks measured ~0s of
// shuffle fetch wait (222 of 284 shuffle findings). No executor data falls back to one device.
export function stageIoParallelism(stage: Stage): number {
  const executors = Array.isArray(stage.executorStats) ? stage.executorStats.length : 0;
  return Math.max(1, executors);
}

// Wall-clock the stage's tasks spent blocked fetching shuffle blocks: fetchWaitTime is a
// cross-task sum like executorRunTime, so dividing by the stage's average concurrency converts it
// (the gc estimate's conversion). Null when the stage has no run time or duration to convert with.
// On 14 real logs the link model claimed 2780s over 284 shuffle findings, 256s once capped at
// this, with about zero fetch wait on 5 of the 10 non-info ones: reads that overlapped compute
// stalled nothing.
export function fetchWaitWallClockMs(stage: Stage): number | null {
  const fetchWaitMs = stage.fetchWaitTime;
  const runTimeMs = stage.executorRunTime ?? 0;
  const durationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  if (typeof fetchWaitMs !== 'number' || runTimeMs <= 0 || durationMs <= 0) return null;
  return fetchWaitMs / (runTimeMs / durationMs);
}

// Wall-clock a stage's wasted (retried) attempts cost it. Each one delayed only its own task, and
// attempts of different tasks ran side by side: one lost executor fails every task it was running
// at once (4 wasted attempts of 36.6s each, all first attempts, on a real stage that ran 41 tasks
// at once, claimed as 146.6s). So the stage lost at most its longest retry chain, the most attempts
// one task wasted (its highest attempt number + 1) times the mean wasted attempt, or their summed
// time spread over its slots, whichever is larger. Without a sample of every wasted attempt
// (retryTaskSamples is capped), the chain isn't known: the summed time.
export function retryWallClockMs(stage: Stage): number {
  const totalMs = (stage.retryWasteMs as number | undefined) ?? 0;
  const attempts = (stage.wastedAttempts as number | undefined) ?? 0;
  const samples = Array.isArray(stage.retryTaskSamples)
    ? (stage.retryTaskSamples as { attemptNumber?: number }[]) : [];
  if (totalMs <= 0 || attempts <= 0 || samples.length < attempts) return totalMs;
  const chain = samples.reduce((longest, s) => Math.max(longest, (s.attemptNumber ?? 0) + 1), 1);
  const slots = Math.max(1, stage.peakConcurrentTasks ?? 1);
  return Math.min(totalMs, Math.max((chain * totalMs) / attempts, totalMs / slots));
}
// Spark's classic recommended shuffle partition size.
export const IDEAL_BYTES_PER_PARTITION_TASK = 128 * 1024 * 1024;
// Assumed per-task scheduling/launch overhead: the fallback when a stage lacks the per-executor
// task-time sums measuredTaskOverhead needs.
export const TASK_SCHEDULING_OVERHEAD_MS = 50;
// Assumed per-file open latency (small-file overhead).
export const FILE_OPEN_OVERHEAD_MS = 10;
// Assumed broadcast-transfer bandwidth, shared with overBroadcast/underBroadcast.
export const BROADCAST_BANDWIDTH_BPS = 125_000_000;
// Assumed per-non-local-task network-fetch penalty, reported as extra core-time.
export const NETWORK_FETCH_PENALTY_MS = 20;
// Assumed executor JVM+container startup overhead.
export const EXECUTOR_STARTUP_OVERHEAD_MS = 15000;
// Assumed re-read throughput, shared by cachingOpportunity and cacheUtilization.
export const RE_READ_THROUGHPUT_BPS = 125_000_000;

// Below this share of executorRunTime spent on CPU, a stage's tasks were idle, waiting on something
// outside Spark: on 14 real logs (2026-09-23) every non-Python stage under 1% was a JDBC read, a
// file listing or a Delta log read, while file writes, which more partitions do parallelize,
// start at 2%.
const IDLE_CPU_SHARE_MAX = 0.01;

// True when the stage's tasks spent under IDLE_CPU_SHARE_MAX of their run time on CPU. False when
// the share can't be trusted: no CPU time recorded (older Spark logs omit the metric), or Python
// code run through a Python worker (isPythonStage: a PythonRDD stage or a Python UDF operator in
// its SQL plan), whose worker-process CPU executorCpuTime (the JVM task thread's) never counts
// (such stages read 0.1% on the same logs while computing).
export function tasksMostlyIdle(stage: Stage, sql: Map<number, SqlExecution> = new Map()): boolean {
  const runMs = stage.executorRunTime ?? 0;
  const cpuMs = nsToMs(stage.executorCpuTime ?? 0);
  if (runMs <= 0 || cpuMs <= 0) return false;
  if (isPythonStage(stage, sql)) return false;
  return cpuMs / runMs < IDLE_CPU_SHARE_MAX;
}

// skew, straggler, stageSlowness and lowShuffleParallelism claim time off the stage's longest task
// itself, so the occupancy clip must not floor them at that same task (see estimateSingleStage).
export const TAIL_CLAIM: SingleStageEstimateOptions = { shortensLongestTask: true };

// No quantifiable magnitude -> 'informational'; a rawWaste figure with no stage window ->
// 'resourceOnly'. Never a fake {low:0, high:0}: wallClock is null in both cases.
export function costOnly(estimateMethod: ImpactEstimateMethod, rawWaste?: RawWasteFigure): ImpactEstimate {
  return rawWaste
    ? { basis: 'resourceOnly', wallClock: null, estimateMethod, rawWaste }
    : { basis: 'informational', wallClock: null, estimateMethod };
}

/** The estimate() of an entry whose findings have no waste model at all. */
export function noWasteModel(): ImpactEstimate {
  return costOnly('none');
}

export function singleStageImpact(
  wasteMs: number,
  stageId: number,
  ctx: EstimateCtx,
  estimateMethod: ImpactEstimateMethod,
  rawWaste?: RawWasteFigure,
  opts?: SingleStageEstimateOptions,
): ImpactEstimate {
  const est = estimateSingleStage(wasteMs, stageId, ctx.stages as unknown as Map<number, OccupancyStage>, ctx.occupancy, opts);
  if (est) return { basis: est.basis, wallClock: est.wallClock, estimateMethod, rawWaste };
  return costOnly(estimateMethod, rawWaste); // stage excluded from the sweep (duration <= 0)
}

/** estimateMultiStage over the finding's own stages, or null when every one was excluded from
 * the sweep. */
export function multiStageImpact(
  stageIds: number[],
  wasteMsByStage: Map<number, number>,
  ctx: EstimateCtx,
  estimateMethod: ImpactEstimateMethod,
  rawWaste?: RawWasteFigure,
): ImpactEstimate | null {
  const est = estimateMultiStage(stageIds, wasteMsByStage, ctx.stages as unknown as Map<number, OccupancyStage>, ctx.occupancy);
  return est ? { basis: est.basis, wallClock: est.wallClock, estimateMethod, rawWaste } : null;
}

export function stageMappableWasteOrCostOnly(
  wasteMs: number,
  stageIds: number[] | undefined,
  ctx: EstimateCtx,
): ImpactEstimate {
  const rawWaste: RawWasteFigure | undefined = wasteMs > 0 ? { value: wasteMs, unit: 'ms' } : undefined;
  if (!stageIds || stageIds.length === 0) {
    return costOnly('modeled', rawWaste);
  }
  // One waste event spread over a span of stages, not N independent wastes: apportion evenly so
  // estimateMultiStage's union cap doesn't absorb the same amount claimed once per stage.
  const perStageWasteMs = wasteMs / stageIds.length;
  const wasteMsByStage = new Map(stageIds.map((id) => [id, perStageWasteMs]));
  // null: every stage excluded from the sweep
  return multiStageImpact(stageIds, wasteMsByStage, ctx, 'modeled', rawWaste) ?? costOnly('modeled', rawWaste);
}

// Finding types whose raw figure is busy core time read straight from the log: gc's jvmGCTime
// (coreMs) and the discarded speculative or retried attempts' run time ('ms' cross-task sums).
// Any other core figure is idle capacity, or modeled on an assumed constant (coreLocality's
// per-task fetch penalty, autoscalingChurn's executor-hours, jobFailureRate's job-hours).
const MEASURED_CORE_TIME_FIGURE: ReadonlySet<string> = new Set(['gc', 'retryWaste', 'speculationWaste']);

/** The busy core time a finding's fix removes, in core-milliseconds, or null when the detector
 * measures none. Only a measured figure counts: one its estimate() already set (skew and
 * straggler's removed task time), or the raw figure of a MEASURED_CORE_TIME_FIGURE type. A
 * wall-clock claim, an idle capacity figure and a modeled figure are never converted. It never
 * reads executorCpuTime, which leaves out Python worker CPU. */
export function coreTimeFor(finding: Finding, estimate: ImpactEstimate): { low: number; high: number } | null {
  if (estimate.coreTimeMs !== undefined) return estimate.coreTimeMs;
  const raw = estimate.rawWaste;
  if (!raw || !MEASURED_CORE_TIME_FIGURE.has(finding.type)) return null;
  return { low: raw.value, high: raw.value };
}
