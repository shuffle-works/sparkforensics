import { coreCountHistogram } from './core-time-series.ts';
import type { FailedTaskSample, StageRecord } from './event-handlers.ts';
import { medianOfSorted } from './median.ts';
import type { TaskFailureDetail, TaskFailureGroup } from './task-failure.ts';
import type { StageAttemptTotals, TailAttribution } from './types.ts';

// Single source of truth for the packed per-task numeric array: FIELDS (offset
// constants), TASK_FIELD_NAMES (display labels), and the finalizeStage hot-loop
// push order are all derived from this list. `prop` is the task record's real
// property name, kept separate from `name` since MEM_SPILLED's display label
// ('memorySpilled') differs from it (memSpilled).
type TaskNumericProp = 'duration' | 'gcTime' | 'memSpilled' | 'diskSpilled' | 'shuffleRead' | 'shuffleWrite' | 'launchTime' | 'finishTime';
interface TaskFieldDescriptor {
  key: string;
  name: string;
  prop: TaskNumericProp;
}

const TASK_FIELD_DESCRIPTORS: TaskFieldDescriptor[] = [
  { key: 'DURATION', name: 'duration', prop: 'duration' },
  { key: 'GC_TIME', name: 'gcTime', prop: 'gcTime' },
  { key: 'MEM_SPILLED', name: 'memorySpilled', prop: 'memSpilled' },
  { key: 'DISK_SPILLED', name: 'diskSpilled', prop: 'diskSpilled' },
  { key: 'SHUFFLE_READ', name: 'shuffleRead', prop: 'shuffleRead' },
  { key: 'SHUFFLE_WRITE', name: 'shuffleWrite', prop: 'shuffleWrite' },
  { key: 'LAUNCH_TIME', name: 'launchTime', prop: 'launchTime' },
  { key: 'FINISH_TIME', name: 'finishTime', prop: 'finishTime' },
];

const STRIDE = TASK_FIELD_DESCRIPTORS.length;

// Mirrors event-handlers.ts's MAX_TASK_SAMPLES (kept as a separate constant to avoid a circular
// value import between the two modules: see that file's comment).
const MAX_TASK_SAMPLES = 20;

export const FIELDS = Object.freeze({
  ...Object.fromEntries(TASK_FIELD_DESCRIPTORS.map((d, i) => [d.key, i])),
  STRIDE,
}) as Readonly<{
  DURATION: 0; GC_TIME: 1; MEM_SPILLED: 2; DISK_SPILLED: 3; SHUFFLE_READ: 4;
  SHUFFLE_WRITE: 5; LAUNCH_TIME: 6; FINISH_TIME: 7; STRIDE: 8;
}>;

export const TASK_FIELD_NAMES: string[] = TASK_FIELD_DESCRIPTORS.map((d) => d.name);

const TASK_FIELD_PROPS = TASK_FIELD_DESCRIPTORS.map((d) => d.prop);

export interface StageHostStat { host: string; taskCount: number; totalDuration: number; }
export interface StageExecutorStat {
  executorId: string; taskCount: number; totalDuration: number;
  // Sum and Welford M2 of ln(1 + task duration) over the executor's tasks: the stage's task spread
  // on the log scale.
  logDurationSum: number; logDurationM2: number;
  inputBytes: number; shuffleReadBytes: number; shuffleWriteBytes: number;
}
export interface StageFailureReason { reason: string; count: number; }
export interface StageLocalityStat { locality: string; count: number; }
// Per-executor snapshot from a StageExecutorMetrics event: Spark's ExecutorMetrics field names, only
// a few of which any detector reads.
export interface StageExecutorMetricsSnapshot {
  jvmHeapMemory?: number;
  onHeapStorageMemory?: number;
  offHeapStorageMemory?: number;
  [key: string]: number | undefined;
}

// A stage as finalizeStage posts it, the one place a stage is built. The record's internal
// accumulation state (task attempts, intern tables, late-event bookkeeping) is not part of it.
export interface FinalizedStage {
  id: number;
  name: string;
  details: string;
  stageType: 'REDUCE' | 'MAP';
  sqlExecutionId: number | null;
  submittedAt: number;
  completedAt: number;
  parentIds: number[];
  taskCount: number;
  failedTasks: number;
  speculativeTasks: number;
  stageFailureReason: string | null;
  // Times the stage was submitted and how many of those attempts failed, counted across resubmits.
  stageAttempts: number;
  failedStageAttempts: number;
  // The summed work of the attempts before the latest one, which the stage's own figures leave out;
  // null when the stage ran once. Read only by the CLI's metrics block.
  earlierAttempts: StageAttemptTotals | null;
  // The summed work the stage's own figures also leave out: a failed attempt's tasks that ended
  // after its StageCompleted, and task attempts another attempt of the same task superseded
  // (failed retries, losing speculative copies); null when there was none.
  lateAttemptWork: StageAttemptTotals | null;
  inputBytes: number;
  outputBytes: number;
  // Summed Records Written; null when no task of the stage reported one.
  outputRecords: number | null;
  shuffleReadBytes: number;
  shuffleReadP50: number;
  shuffleReadP95: number;
  shuffleReadMax: number;
  shuffleWriteBytes: number;
  fetchWaitTime: number;
  memoryBytesSpilled: number;
  diskBytesSpilled: number;
  spillMemP50: number;
  spillMemP95: number;
  spillMemMax: number;
  spillDiskP50: number;
  spillDiskP95: number;
  spillDiskMax: number;
  spillClassification: 'skew' | 'volume' | 'unclassified';
  jvmGCTime: number;
  executorRunTime: number;
  // Summed task CPU time, in nanoseconds (Spark's unit); 0 on logs that predate the metric.
  executorCpuTime: number;
  gcPct: number;
  taskDurationP50: number;
  taskDurationP95: number;
  taskDurationMax: number;
  peakExecutionMemoryMax: number;
  // Wall-clock ms during which at least one of the stage's tasks ran.
  taskActiveMs: number;
  stragglerCount: number;
  // Summed (duration - P50) over the tasks slower than STRAGGLER_FACTOR x P50, core-ms.
  stragglerExcessMs: number;
  // Longest task at or under STRAGGLER_FACTOR x P50, the longest a straggler fix leaves.
  longestNonStragglerMs: number;
  // Wall-clock a list-scheduling replay of the stage's tasks recovers with every task over
  // STRAGGLER_FACTOR x P50 capped at P50, ms.
  tailReplayRecoveryMs: number;
  // Most of the stage's tasks running at once.
  peakConcurrentTasks: number;
  // What the stage's slow tail was made of; absent when no task ran over TAIL_FACTOR x P50.
  tailAttribution?: TailAttribution;
  hostStats: StageHostStat[];
  executorStats: StageExecutorStat[];
  executorMetrics: Map<string, StageExecutorMetricsSnapshot>;
  failureReasons: StageFailureReason[];
  failureGroups: TaskFailureGroup[];
  // Failures of the attempts a retry superseded, most frequent first.
  retryFailureGroups: TaskFailureGroup[];
  localityStats: StageLocalityStat[];
  failedTaskSamples: FailedTaskSample[];
  retryTaskSamples: FailedTaskSample[];
  retryWasteMs: number;
  wastedAttempts: number;
  speculationWasteMs: number;
  speculationWastedAttempts: number;
}

export function finalizeStage(
  stageId: number,
  stage: StageRecord,
  state: { taskStore: Map<number, Float64Array> }
): { type: 'stage'; data: FinalizedStage } | null {
  // Already finalized (e.g. a duplicate/replayed StageCompleted event):
  // degrade gracefully instead of crashing on stage.taskAttempts.values().
  const attempts = stage.taskAttempts;
  if (attempts === null) return null;

  const buf: number[] = [];
  let taskCount = 0, failedTasks = 0, speculativeTasks = 0;
  const hostStats = new Map<string, { taskCount: number; totalDuration: number }>();
  const executorStats = new Map<string, Omit<StageExecutorStat, 'executorId'>>();
  const failureReasons = new Map<string, number>();
  const failedTaskSamples: FailedTaskSample[] = [];
  // Keyed by the interned detail object: accumulateTask shares one per distinct failure.
  const failureGroups = new Map<TaskFailureDetail, number>();
  const localityStats = new Map<string, number>();
  let peakExecutionMemoryMax = 0;

  for (const t of attempts.values()) {
    taskCount++;
    if (t.failed) {
      failedTasks++;
      if (t.reason) failureReasons.set(t.reason, (failureReasons.get(t.reason) ?? 0) + 1);
      const failure = t.failure;
      if (failure) failureGroups.set(failure, (failureGroups.get(failure) ?? 0) + 1);
      if (failedTaskSamples.length < MAX_TASK_SAMPLES) {
        failedTaskSamples.push({
          taskId: t.taskId, attemptNumber: t.attemptNumber, host: t.host, executorId: t.executorId,
          reason: t.reason, peakExecMem: t.peakExecMem, memSpilled: t.memSpilled, shuffleWrite: t.shuffleWrite,
        });
      }
    }
    if (t.speculative) speculativeTasks++;
    if (t.host) {
      let hs = hostStats.get(t.host);
      if (!hs) { hs = { taskCount: 0, totalDuration: 0 }; hostStats.set(t.host, hs); }
      hs.taskCount++;
      hs.totalDuration += t.duration;
    }
    if (t.executorId) {
      let es = executorStats.get(t.executorId);
      if (!es) { es = { taskCount: 0, totalDuration: 0, logDurationSum: 0, logDurationM2: 0, inputBytes: 0, shuffleReadBytes: 0, shuffleWriteBytes: 0 }; executorStats.set(t.executorId, es); }
      // Task durations scatter multiplicatively, so the spread slowHost tests an executor against is
      // kept on the log scale: a running sum and Welford's M2 of ln(1 + duration). A non-finite
      // duration makes both NaN, which the detector reads as "no spread known".
      const logDuration = Math.log1p(t.duration);
      const logMeanBefore = es.taskCount > 0 ? es.logDurationSum / es.taskCount : 0;
      const logMeanAfter = (es.logDurationSum + logDuration) / (es.taskCount + 1);
      es.logDurationM2 += (logDuration - logMeanBefore) * (logDuration - logMeanAfter);
      es.logDurationSum += logDuration;
      es.taskCount++;
      es.totalDuration += t.duration;
      es.inputBytes += t.inputBytes;
      es.shuffleReadBytes += t.shuffleRead;
      es.shuffleWriteBytes += t.shuffleWrite;
    }
    if (t.locality) {
      localityStats.set(t.locality, (localityStats.get(t.locality) ?? 0) + 1);
    }
    if (t.peakExecMem > peakExecutionMemoryMax) peakExecutionMemoryMax = t.peakExecMem;
    stage.shuffleReadBytes += t.shuffleRead;
    stage.shuffleWriteBytes += t.shuffleWrite;
    stage.fetchWaitTime += t.fetchWaitTime;
    stage.memoryBytesSpilled += t.memSpilled;
    stage.diskBytesSpilled += t.diskSpilled;
    stage.jvmGCTime += t.gcTime;
    stage.executorRunTime += t.executorRunTime;
    stage.executorCpuTime += t.executorCpuTime;
    stage.inputBytes += t.inputBytes;
    stage.outputBytes += t.outputBytes;
    if (t.outputRecords != null) stage.outputRecords = (stage.outputRecords ?? 0) + t.outputRecords;
    for (let i = 0; i < TASK_FIELD_PROPS.length; i++) buf.push(t[TASK_FIELD_PROPS[i]]);
  }
  stage.taskCount = taskCount;
  stage.peakExecutionMemoryMax = peakExecutionMemoryMax;
  stage.failedTasks = failedTasks;
  stage.speculativeTasks = speculativeTasks;
  stage.taskAttempts = null; // no longer needed after finalize, freeing memory
  stage.failureDetails = null;

  const arr = new Float64Array(buf);
  state.taskStore.set(stageId, arr);

  const { p50, p95, max } = computeDurationQuantiles(arr);
  const spillClass = stage.memoryBytesSpilled > 0 ? classifySpill(arr) : 'unclassified';
  const { p50: shuffleReadP50, p95: shuffleReadP95, max: shuffleReadMax } = computeFieldQuantiles(arr, FIELDS.SHUFFLE_READ);
  const { p50: spillMemP50, p95: spillMemP95, max: spillMemMax } = computeFieldQuantiles(arr, FIELDS.MEM_SPILLED);
  const { p50: spillDiskP50, p95: spillDiskP95, max: spillDiskMax } = computeFieldQuantiles(arr, FIELDS.DISK_SPILLED);

  // Straggler count: tasks with duration > STRAGGLER_FACTOR * P50, their summed excess over P50, and
  // the longest task that isn't one.
  const stragglerThreshold = STRAGGLER_FACTOR * p50;
  let stragglerCount = 0;
  let stragglerExcessMs = 0;
  let longestNonStragglerMs = 0;
  const taskArrCount = arr.length / FIELDS.STRIDE;
  if (p50 > 0) {
    for (let i = 0; i < taskArrCount; i++) {
      const duration = arr[i * FIELDS.STRIDE + FIELDS.DURATION];
      if (duration > stragglerThreshold) { stragglerCount++; stragglerExcessMs += duration - p50; }
      else if (duration > longestNonStragglerMs) longestNonStragglerMs = duration;
    }
  }

  const tailAttribution = p50 > 0 ? attributeTail(attempts.values(), p50) : null;
  const peakConcurrentTasks = computePeakConcurrentTasks(arr);
  const tailReplayRecoveryMs = stragglerCount > 0
    ? computeTailReplayRecoveryMs(arr, p50, peakConcurrentTasks)
    : 0; // no task over 4x P50: both replays schedule the same durations

  const hostStatsArr = [...hostStats.entries()].map(
    ([host, s]) => ({ host, taskCount: s.taskCount, totalDuration: s.totalDuration })
  );
  const executorStatsArr = [...executorStats.entries()].map(
    ([executorId, s]) => ({ executorId, taskCount: s.taskCount, totalDuration: s.totalDuration, logDurationSum: s.logDurationSum, logDurationM2: s.logDurationM2, inputBytes: s.inputBytes, shuffleReadBytes: s.shuffleReadBytes, shuffleWriteBytes: s.shuffleWriteBytes })
  );
  const failureReasonsArr = [...failureReasons.entries()].map(
    ([reason, count]) => ({ reason, count })
  );
  // Most frequent first; ties keep first-seen order (Array.prototype.sort is stable).
  const failureGroupsArr: TaskFailureGroup[] = [...failureGroups.entries()]
    .map(([detail, count]) => ({ ...detail, count }))
    .sort((a, b) => b.count - a.count);
  const retryFailureGroups: TaskFailureGroup[] = [...stage.retryFailures.entries()]
    .map(([detail, count]) => ({ ...detail, count }))
    .sort((a, b) => b.count - a.count);
  const localityStatsArr = [...localityStats.entries()].map(
    ([locality, count]) => ({ locality, count })
  );

  const data: FinalizedStage = {
    id: stage.id, name: stage.name, details: stage.details,
    stageType: stage.shuffleReadBytes > 0 ? 'REDUCE' : 'MAP',
    sqlExecutionId: stage.sqlExecutionId,
    submittedAt: stage.submittedAt, completedAt: stage.completedAt, parentIds: stage.parentIds,
    taskCount, failedTasks, speculativeTasks,
    stageFailureReason: stage.stageFailureReason,
    stageAttempts: stage.stageAttempts, failedStageAttempts: stage.failedStageAttempts,
    earlierAttempts: stage.earlierAttempts, lateAttemptWork: stage.lateAttemptWork,
    inputBytes: stage.inputBytes, outputBytes: stage.outputBytes, outputRecords: stage.outputRecords,
    shuffleReadBytes: stage.shuffleReadBytes, shuffleReadP50, shuffleReadP95, shuffleReadMax,
    shuffleWriteBytes: stage.shuffleWriteBytes, fetchWaitTime: stage.fetchWaitTime,
    memoryBytesSpilled: stage.memoryBytesSpilled, diskBytesSpilled: stage.diskBytesSpilled,
    spillMemP50, spillMemP95, spillMemMax,
    spillDiskP50, spillDiskP95, spillDiskMax,
    spillClassification: spillClass,
    jvmGCTime: stage.jvmGCTime, executorRunTime: stage.executorRunTime, executorCpuTime: stage.executorCpuTime,
    gcPct: stage.executorRunTime > 0 ? (stage.jvmGCTime / stage.executorRunTime) * 100 : 0,
    taskDurationP50: p50, taskDurationP95: p95, taskDurationMax: max,
    peakExecutionMemoryMax,
    taskActiveMs: computeTaskActiveMs(arr),
    stragglerCount, stragglerExcessMs, longestNonStragglerMs, tailReplayRecoveryMs,
    peakConcurrentTasks,
    ...(tailAttribution ? { tailAttribution } : {}),
    hostStats: hostStatsArr, executorStats: executorStatsArr,
    executorMetrics: stage.executorMetrics,
    failureReasons: failureReasonsArr,
    failureGroups: failureGroupsArr,
    retryFailureGroups,
    localityStats: localityStatsArr,
    failedTaskSamples,
    retryTaskSamples: stage.retryTaskSamples,
    retryWasteMs: stage.retryWasteMs, wastedAttempts: stage.wastedAttempts,
    speculationWasteMs: stage.speculationWasteMs, speculationWastedAttempts: stage.speculationWastedAttempts,
  };

  return { type: 'stage', data };
}

// A task is in the tail when it runs over this many times the stage's median task: skew's own
// P95/median ratio threshold, so every stage either detector flags on duration has a tail here.
export const TAIL_FACTOR = 3;

// A task is a straggler when it runs over this many times the stage's median task.
export const STRAGGLER_FACTOR = 4;

// The per-task fields attributeTail reads; a TaskRecord in event-handlers.ts has all of them.
interface TailTask {
  failed: boolean;
  duration: number;
  host: string;
  gcTime: number;
  fetchWaitTime: number;
  executorRunTime: number;
  executorCpuTime: number;
  inputBytes: number;
  inputRecords: number;
  shuffleRead: number;
  shuffleReadRecords: number;
}

// A hosts-concentration reading needs this many tail tasks on the host, at least this share of the
// tail, and at least this multiple of the host's share of all tasks, before the host explains the
// excess the other causes leave. One slow task on a host that ran a tenth of the stage is chance.
const TAIL_HOST_MIN_TASKS = 3;
const TAIL_HOST_MIN_TAIL_SHARE = 0.5;
const TAIL_HOST_MIN_OVERREPRESENTATION = 2;

// A median task that read next to nothing makes every ratio against it huge (a median of 4 bytes
// against a 1 MB task reads as 250000x). Below these floors the median task is read as having
// read almost nothing: there is no ratio to take, and a task counts as having read data only from
// the floors up.
const MIN_VOLUME_BYTES = 1024 * 1024;
const MIN_VOLUME_RECORDS = 1000;

// Why the stage's slow tasks (non-failed, over TAIL_FACTOR x P50) were slow, from what each task
// logged. A task's excess is its duration over P50. Four causes claim it, in this order so no
// millisecond counts twice:
//   1. Data: had run time scaled with data volume, the task would have taken P50 x (volume ratio)
//      against the median task, with volume the task's input plus shuffle-read, in bytes or in
//      records, whichever is further above the median. This is the definition Spark's UI and AQE
//      use for skew (a partition far larger than the median one), applied to run time.
//   2. GC time over the median task's.
//   3. Shuffle fetch wait over the median task's.
//   4. Host: what is left of the tail tasks on the one host that holds most of the tail.
// With a median task that read almost nothing there is no ratio to take, so GC and fetch wait claim their
// excess first and a task that read data owns what they leave: the time was GC or waiting unless
// the data is all that is left to explain it.
// Null when the stage has no tail. `tasks` is consumed once.
export function attributeTail(tasks: Iterable<TailTask>, p50: number): TailAttribution | null {
  const all: TailTask[] = [];
  const tail: TailTask[] = [];
  for (const t of tasks) {
    if (t.failed) continue; // a failed attempt's metrics stop where it died
    all.push(t);
    if (t.duration > TAIL_FACTOR * p50) tail.push(t);
  }
  if (tail.length === 0) return null;

  const bytesOf = (t: TailTask) => t.inputBytes + t.shuffleRead;
  const recordsOf = (t: TailTask) => t.inputRecords + t.shuffleReadRecords;
  const medianBytes = medianOf(all, bytesOf);
  const medianRecords = medianOf(all, recordsOf);
  const medianGc = medianOf(all, (t) => t.gcTime);
  const medianFetch = medianOf(all, (t) => t.fetchWaitTime);
  const bytesComparable = medianBytes >= MIN_VOLUME_BYTES;
  const recordsComparable = medianRecords >= MIN_VOLUME_RECORDS;
  const hasVolume = bytesComparable || recordsComparable;
  const volumeRatio = (t: TailTask): number => Math.max(
    bytesComparable ? bytesOf(t) / medianBytes : 0,
    recordsComparable ? recordsOf(t) / medianRecords : 0,
  );
  const readsData = (t: TailTask) => bytesOf(t) >= MIN_VOLUME_BYTES || recordsOf(t) >= MIN_VOLUME_RECORDS;

  const tailHosts = new Map<string, number>();
  const allHosts = new Map<string, number>();
  for (const t of all) if (t.host) allHosts.set(t.host, (allHosts.get(t.host) ?? 0) + 1);
  for (const t of tail) if (t.host) tailHosts.set(t.host, (tailHosts.get(t.host) ?? 0) + 1);
  let topHost: string | null = null;
  for (const [host, n] of tailHosts) if (topHost === null || n > tailHosts.get(topHost)!) topHost = host;
  const hostConcentrated = topHost !== null
    && tailHosts.get(topHost)! >= TAIL_HOST_MIN_TASKS
    && tailHosts.get(topHost)! / tail.length >= TAIL_HOST_MIN_TAIL_SHARE
    && (tailHosts.get(topHost)! / tail.length) / (allHosts.get(topHost)! / all.length) >= TAIL_HOST_MIN_OVERREPRESENTATION;

  let excessMs = 0, dataMs = 0, gcMs = 0, fetchWaitMs = 0, hostMs = 0, cpuNs = 0, runMs = 0;
  const ratios: number[] = [];
  for (const t of tail) {
    const excess = t.duration - p50;
    excessMs += excess;
    let left = excess;
    if (hasVolume) {
      const ratio = volumeRatio(t);
      ratios.push(ratio);
      const data = Math.min(left, Math.max(0, p50 * (ratio - 1)));
      dataMs += data; left -= data;
    }
    const gc = Math.min(left, Math.max(0, t.gcTime - medianGc));
    gcMs += gc; left -= gc;
    const fetch = Math.min(left, Math.max(0, t.fetchWaitTime - medianFetch));
    fetchWaitMs += fetch; left -= fetch;
    if (!hasVolume && readsData(t)) { dataMs += left; left = 0; }
    if (hostConcentrated && t.host === topHost) { hostMs += left; }
    cpuNs += t.executorCpuTime;
    runMs += t.executorRunTime;
  }
  ratios.sort((a, b) => a - b);
  return {
    tasks: tail.length, excessMs, dataMs, gcMs, fetchWaitMs, hostMs,
    host: hostConcentrated ? topHost : null,
    hostTasks: hostConcentrated ? tailHosts.get(topHost!)! : 0,
    dataRatio: hasVolume ? medianOfSorted(Float64Array.from(ratios)) : null,
    cpuPct: cpuNs > 0 && runMs > 0 ? Math.min(100, (cpuNs / 1e6 / runMs) * 100) : null,
  };
}

function medianOf(tasks: TailTask[], valueOf: (t: TailTask) => number): number {
  return medianOfSorted(Float64Array.from(tasks, valueOf).sort());
}

// Wall-clock time during which at least one of the stage's tasks was running: the union of its
// [launch, finish) intervals. A stage's submittedAt..completedAt window also covers time it sat
// open with no task running (waiting for a free slot, or between retried tasks), which no
// task-level fix can compress. Tasks missing either timestamp are skipped.
export function computeTaskActiveMs(arr: Float64Array): number {
  const taskCount = arr.length / FIELDS.STRIDE;
  const launches = new Float64Array(taskCount);
  const finishes = new Float64Array(taskCount);
  let n = 0;
  for (let i = 0; i < taskCount; i++) {
    const launch = arr[i * FIELDS.STRIDE + FIELDS.LAUNCH_TIME];
    const finish = arr[i * FIELDS.STRIDE + FIELDS.FINISH_TIME];
    if (launch > 0 && finish > launch) { launches[n] = launch; finishes[n++] = finish; }
  }
  // The time with at least one task running: every busy-core bucket above zero.
  const histogram = coreCountHistogram(launches.subarray(0, n), finishes.subarray(0, n));
  let activeMs = 0;
  for (let k = 1; k < histogram.length; k++) activeMs += histogram[k];
  return activeMs;
}

// Most tasks running at once, over the same [launch, finish) intervals as computeTaskActiveMs: the
// slots the stage actually got. A task finishing at the instant another launches frees its slot.
export function computePeakConcurrentTasks(arr: Float64Array): number {
  const taskCount = arr.length / FIELDS.STRIDE;
  const launches: number[] = [];
  const finishes: number[] = [];
  for (let i = 0; i < taskCount; i++) {
    const launch = arr[i * FIELDS.STRIDE + FIELDS.LAUNCH_TIME];
    const finish = arr[i * FIELDS.STRIDE + FIELDS.FINISH_TIME];
    if (launch > 0 && finish > launch) { launches.push(launch); finishes.push(finish); }
  }
  launches.sort((a, b) => a - b);
  finishes.sort((a, b) => a - b);
  let peak = 0, running = 0, finished = 0;
  for (const launch of launches) {
    while (finished < finishes.length && finishes[finished] <= launch) { running--; finished++; }
    running++;
    if (running > peak) peak = running;
  }
  return peak;
}

// Wall-clock a tail fix recovers, replayed from the stage's own tasks: list scheduling (tasks in
// launch order, each on the slot that frees first) over `slots` slots, once with the real
// durations and once with every task over 4x P50 (the straggler definition above) capped at P50.
// The difference is the claim; dev/eval-tail-replay.mjs keeps an independent copy as its ground
// truth. Equal free times are interchangeable slots, so which one a min-heap picks can't change
// the result. Equal launch times keep the task array's order.
export function computeTailReplayRecoveryMs(arr: Float64Array, p50: number, slots: number): number {
  const taskCount = arr.length / FIELDS.STRIDE;
  if (taskCount < 2 || !(p50 > 0)) return 0;
  const order = new Uint32Array(taskCount);
  for (let i = 0; i < taskCount; i++) order[i] = i;
  order.sort((a, b) => arr[a * FIELDS.STRIDE + FIELDS.LAUNCH_TIME] - arr[b * FIELDS.STRIDE + FIELDS.LAUNCH_TIME] || a - b);
  const free = new Float64Array(Math.max(1, Math.min(slots, taskCount)));
  const capAboveMs = 4 * p50;
  const actualEndMs = listScheduleEndMs(arr, order, free, Infinity, p50);
  const fixedEndMs = listScheduleEndMs(arr, order, free, capAboveMs, p50);
  return Math.max(0, actualEndMs - fixedEndMs);
}

// End of a list schedule over `free` (a min-heap of slot free times, reset here), each task's
// duration replaced by `cappedMs` when over `capAboveMs`.
function listScheduleEndMs(
  arr: Float64Array, order: Uint32Array, free: Float64Array, capAboveMs: number, cappedMs: number,
): number {
  free.fill(0);
  const n = free.length;
  let endMs = 0;
  for (let t = 0; t < order.length; t++) {
    const duration = arr[order[t] * FIELDS.STRIDE + FIELDS.DURATION];
    const finish = free[0] + (duration > capAboveMs ? cappedMs : duration);
    if (finish > endMs) endMs = finish;
    // Replace the root (earliest free slot) and sift it down.
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const child = left + 1 < n && free[left + 1] < free[left] ? left + 1 : left;
      if (free[child] >= finish) break;
      free[i] = free[child];
      i = child;
    }
    free[i] = finish;
  }
  return endMs;
}

// p50 is the textbook median (the mean of the two middle values on an even count); p95 is nearest-rank.
export function computeFieldQuantiles(arr: Float64Array, fieldIndex: number): { p50: number; p95: number; max: number } {
  const taskCount = arr.length / FIELDS.STRIDE;
  if (taskCount === 0) return { p50: 0, p95: 0, max: 0 };

  const values = new Float64Array(taskCount);
  for (let i = 0; i < taskCount; i++) values[i] = arr[i * FIELDS.STRIDE + fieldIndex];
  values.sort();

  return {
    p50: medianOfSorted(values),
    p95: values[Math.ceil(taskCount * 0.95) - 1],
    max: values[taskCount - 1],
  };
}

export function computeDurationQuantiles(arr: Float64Array): { p50: number; p95: number; max: number } {
  return computeFieldQuantiles(arr, FIELDS.DURATION);
}

export function classifySpill(arr: Float64Array): 'unclassified' | 'skew' | 'volume' {
  const taskCount = arr.length / FIELDS.STRIDE;
  if (taskCount === 0) return 'unclassified';

  let zeroCount = 0;
  for (let i = 0; i < taskCount; i++) {
    if (arr[i * FIELDS.STRIDE + FIELDS.MEM_SPILLED] === 0) zeroCount++;
  }

  const zeroFraction = zeroCount / taskCount;
  if (zeroFraction >= 0.80) return 'skew';
  if (zeroFraction < 0.20) return 'volume';
  return 'unclassified';
}
