import type { FailedTaskSample } from './event-handlers.ts';
import { medianOfSorted } from './median.ts';
import type { TaskFailureDetail, TaskFailureGroup } from './task-failure.ts';
import type { TailAttribution } from './types.ts';

// Single source of truth for the packed per-task numeric array: FIELDS (offset
// constants), TASK_FIELD_NAMES (display labels), and the finalizeStage hot-loop
// push order are all derived from this list. `prop` is the task record's real
// property name, kept separate from `name` since MEM_SPILLED's display label
// ('memorySpilled') differs from it (memSpilled).
interface TaskFieldDescriptor {
  key: string;
  name: string;
  prop: string;
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

// Numeric accumulator fields on `stage` that this function reads/increments.
// `stage`'s public parameter type stays the loose Record shape per this
// module's Produces contract; this narrow view is only for the arithmetic
// below, never a restatement of the object's real shape.
interface StageNumericAccumulator {
  shuffleReadBytes: number;
  shuffleWriteBytes: number;
  fetchWaitTime: number;
  memoryBytesSpilled: number;
  diskBytesSpilled: number;
  jvmGCTime: number;
  executorRunTime: number;
  executorCpuTime: number;
  inputBytes: number;
  outputBytes: number;
  outputRecords: number | null;
}

export function finalizeStage(
  stageId: number,
  stage: Record<string, unknown> & { taskAttempts: Map<unknown, Record<string, number>> | null },
  state: { taskStore: Map<number, Float64Array> }
): { type: 'stage'; data: Record<string, unknown> } | null {
  // Already finalized (e.g. a duplicate/replayed StageCompleted event):
  // degrade gracefully instead of crashing on stage.taskAttempts.values().
  if (stage.taskAttempts === null) return null;

  const acc = stage as unknown as StageNumericAccumulator;

  const buf: number[] = [];
  let taskCount = 0, failedTasks = 0, speculativeTasks = 0;
  const hostStats = new Map();
  const executorStats = new Map();
  const failureReasons = new Map();
  const failedTaskSamples: FailedTaskSample[] = [];
  // Keyed by the interned detail object: accumulateTask shares one per distinct failure.
  const failureGroups = new Map<TaskFailureDetail, number>();
  const localityStats = new Map();
  let peakExecutionMemoryMax = 0;

  const attempts = stage.taskAttempts;
  for (const t of attempts.values()) {
    taskCount++;
    if (t.failed) {
      failedTasks++;
      if (t.reason) failureReasons.set(t.reason, (failureReasons.get(t.reason) ?? 0) + 1);
      const failure = (t as unknown as { failure?: TaskFailureDetail | null }).failure;
      if (failure) failureGroups.set(failure, (failureGroups.get(failure) ?? 0) + 1);
      if (failedTaskSamples.length < MAX_TASK_SAMPLES) {
        failedTaskSamples.push({
          taskId: t.taskId, attemptNumber: t.attemptNumber, host: t.host, executorId: t.executorId,
          reason: t.reason, peakExecMem: t.peakExecMem, memSpilled: t.memSpilled, shuffleWrite: t.shuffleWrite,
        } as unknown as FailedTaskSample);
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
      if (!es) { es = { taskCount: 0, totalDuration: 0, inputBytes: 0, shuffleReadBytes: 0, shuffleWriteBytes: 0 }; executorStats.set(t.executorId, es); }
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
    acc.shuffleReadBytes += t.shuffleRead;
    acc.shuffleWriteBytes += t.shuffleWrite;
    acc.fetchWaitTime += t.fetchWaitTime;
    acc.memoryBytesSpilled += t.memSpilled;
    acc.diskBytesSpilled += t.diskSpilled;
    acc.jvmGCTime += t.gcTime;
    acc.executorRunTime += t.executorRunTime;
    acc.executorCpuTime += t.executorCpuTime;
    acc.inputBytes += t.inputBytes;
    acc.outputBytes += t.outputBytes;
    if (t.outputRecords != null) acc.outputRecords = (acc.outputRecords ?? 0) + t.outputRecords;
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
  const spillClass = acc.memoryBytesSpilled > 0 ? classifySpill(arr) : 'unclassified';
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

  const tailAttribution = p50 > 0 ? attributeTail(attempts.values() as unknown as Iterable<TailTask>, p50) : null;
  const peakConcurrentTasks = computePeakConcurrentTasks(arr);
  const tailReplayRecoveryMs = stragglerCount > 0
    ? computeTailReplayRecoveryMs(arr, p50, peakConcurrentTasks)
    : 0; // no task over 4x P50: both replays schedule the same durations

  const hostStatsArr = [...hostStats.entries()].map(
    ([host, s]) => ({ host, taskCount: s.taskCount, totalDuration: s.totalDuration })
  );
  const executorStatsArr = [...executorStats.entries()].map(
    ([executorId, s]) => ({ executorId, taskCount: s.taskCount, totalDuration: s.totalDuration, inputBytes: s.inputBytes, shuffleReadBytes: s.shuffleReadBytes, shuffleWriteBytes: s.shuffleWriteBytes })
  );
  const failureReasonsArr = [...failureReasons.entries()].map(
    ([reason, count]) => ({ reason, count })
  );
  // Most frequent first; ties keep first-seen order (Array.prototype.sort is stable).
  const failureGroupsArr: TaskFailureGroup[] = [...failureGroups.entries()]
    .map(([detail, count]) => ({ ...detail, count }))
    .sort((a, b) => b.count - a.count);
  const localityStatsArr = [...localityStats.entries()].map(
    ([locality, count]) => ({ locality, count })
  );

  const data: Record<string, unknown> = {
    ...stage,
    hostStats: hostStatsArr, executorStats: executorStatsArr, failureReasons: failureReasonsArr, localityStats: localityStatsArr, stragglerCount, stragglerExcessMs, longestNonStragglerMs,
    tailReplayRecoveryMs,
    failedTaskSamples,
    failureGroups: failureGroupsArr,
    peakExecutionMemoryMax,
    taskActiveMs: computeTaskActiveMs(arr),
    peakConcurrentTasks,
    ...(tailAttribution ? { tailAttribution } : {}),
    taskDurationP50: p50,
    taskDurationP95: p95,
    taskDurationMax: max,
    shuffleReadP50, shuffleReadP95, shuffleReadMax,
    spillMemP50, spillMemP95, spillMemMax,
    spillDiskP50, spillDiskP95, spillDiskMax,
    gcPct: acc.executorRunTime > 0 ? (acc.jvmGCTime / acc.executorRunTime) * 100 : 0,
    spillClassification: spillClass,
    stageType: acc.shuffleReadBytes > 0 ? 'REDUCE' : 'MAP',
  };
  delete data.taskAttempts; // internal-only field, already nulled above; never part of the public message
  delete data.failureDetails; // internal-only intern table, summarized by failureGroups
  delete data.speculativeWinners; // internal-only late-TaskEnd pairing state, kept worker-side
  delete data.lateSpeculationWaste;
  delete data.stageAttemptId;

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
  const intervals: [number, number][] = [];
  for (let i = 0; i < taskCount; i++) {
    const launch = arr[i * FIELDS.STRIDE + FIELDS.LAUNCH_TIME];
    const finish = arr[i * FIELDS.STRIDE + FIELDS.FINISH_TIME];
    if (launch > 0 && finish > launch) intervals.push([launch, finish]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let activeMs = 0, start = -Infinity, end = -Infinity;
  for (const [launch, finish] of intervals) {
    if (launch > end) {
      if (end > start) activeMs += end - start;
      start = launch;
      end = finish;
    } else if (finish > end) {
      end = finish;
    }
  }
  if (end > start) activeMs += end - start;
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
