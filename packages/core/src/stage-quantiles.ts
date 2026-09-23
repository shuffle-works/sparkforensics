import type { FailedTaskSample } from './event-handlers.ts';

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
  const localityStats = new Map();
  let peakExecutionMemoryMax = 0;

  for (const t of stage.taskAttempts.values()) {
    taskCount++;
    if (t.failed) {
      failedTasks++;
      if (t.reason) failureReasons.set(t.reason, (failureReasons.get(t.reason) ?? 0) + 1);
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
    for (let i = 0; i < TASK_FIELD_PROPS.length; i++) buf.push(t[TASK_FIELD_PROPS[i]]);
  }
  stage.taskCount = taskCount;
  stage.failedTasks = failedTasks;
  stage.speculativeTasks = speculativeTasks;
  stage.taskAttempts = null; // no longer needed after finalize, freeing memory

  const arr = new Float64Array(buf);
  state.taskStore.set(stageId, arr);

  const { p50, p95, max } = computeDurationQuantiles(arr);
  const spillClass = acc.memoryBytesSpilled > 0 ? classifySpill(arr) : 'unclassified';
  const { p50: shuffleReadP50, p95: shuffleReadP95, max: shuffleReadMax } = computeFieldQuantiles(arr, FIELDS.SHUFFLE_READ);
  const { p50: spillMemP50, p95: spillMemP95, max: spillMemMax } = computeFieldQuantiles(arr, FIELDS.MEM_SPILLED);
  const { p50: spillDiskP50, p95: spillDiskP95, max: spillDiskMax } = computeFieldQuantiles(arr, FIELDS.DISK_SPILLED);

  // Straggler count: tasks with duration > 4 * P50.
  const stragglerThreshold = 4 * p50;
  let stragglerCount = 0;
  const taskArrCount = arr.length / FIELDS.STRIDE;
  if (p50 > 0) {
    for (let i = 0; i < taskArrCount; i++) {
      if (arr[i * FIELDS.STRIDE + FIELDS.DURATION] > stragglerThreshold) stragglerCount++;
    }
  }

  const hostStatsArr = [...hostStats.entries()].map(
    ([host, s]) => ({ host, taskCount: s.taskCount, totalDuration: s.totalDuration })
  );
  const executorStatsArr = [...executorStats.entries()].map(
    ([executorId, s]) => ({ executorId, taskCount: s.taskCount, totalDuration: s.totalDuration, inputBytes: s.inputBytes, shuffleReadBytes: s.shuffleReadBytes, shuffleWriteBytes: s.shuffleWriteBytes })
  );
  const failureReasonsArr = [...failureReasons.entries()].map(
    ([reason, count]) => ({ reason, count })
  );
  const localityStatsArr = [...localityStats.entries()].map(
    ([locality, count]) => ({ locality, count })
  );

  const data: Record<string, unknown> = {
    ...stage,
    hostStats: hostStatsArr, executorStats: executorStatsArr, failureReasons: failureReasonsArr, localityStats: localityStatsArr, stragglerCount,
    failedTaskSamples,
    peakExecutionMemoryMax,
    taskActiveMs: computeTaskActiveMs(arr),
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

  return { type: 'stage', data };
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

export function computeFieldQuantiles(arr: Float64Array, fieldIndex: number): { p50: number; p95: number; max: number } {
  const taskCount = arr.length / FIELDS.STRIDE;
  if (taskCount === 0) return { p50: 0, p95: 0, max: 0 };

  const values = new Float64Array(taskCount);
  for (let i = 0; i < taskCount; i++) values[i] = arr[i * FIELDS.STRIDE + fieldIndex];
  values.sort();

  return {
    p50: values[Math.ceil(taskCount * 0.50) - 1],
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
