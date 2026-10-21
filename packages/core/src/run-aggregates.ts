// Whole-run aggregation pass. Runs INSIDE parser-worker.ts over the retained per-task
// launch/finish timestamps in taskStore, so raw task data never reaches the main thread: only the
// compact summary below is posted. Pure and worker-agnostic so it is unit-testable without a Worker.
//
// Uses coreCountHistogram (O(n log n), launch/finish typed arrays and no object per task) to derive
// the busy-core histogram; computeCoreTimeSeries' time-bucket mode is intentionally NOT used here
// because it is O(buckets × segments) and a whole run can hold millions of tasks.

import { FIELDS } from './stage-quantiles.ts';
import { coreCountHistogram } from './core-time-series.ts';

export function computeRunAggregates(taskStore: Map<number, Float64Array>): {
  coreHistogram: number[];
  busyCoreMs: number;
  peakConcurrentCores: number;
  perStage: Record<string, { totalTaskDurationSum: number; taskCount: number }>;
} {
  let totalTasks = 0;
  for (const arr of taskStore.values()) totalTasks += arr.length / FIELDS.STRIDE;
  const launches = new Float64Array(totalTasks);
  const finishes = new Float64Array(totalTasks);
  let intervalCount = 0;
  const perStage: Record<string, { totalTaskDurationSum: number; taskCount: number }> = {};
  for (const [stageId, arr] of taskStore) {
    const taskCount = arr.length / FIELDS.STRIDE;
    let totalTaskDurationSum = 0;
    for (let i = 0; i < taskCount; i++) {
      const base = i * FIELDS.STRIDE;
      const launch = arr[base + FIELDS.LAUNCH_TIME];
      const finish = arr[base + FIELDS.FINISH_TIME];
      totalTaskDurationSum += arr[base + FIELDS.DURATION];
      if (finish > launch) { launches[intervalCount] = launch; finishes[intervalCount++] = finish; }
    }
    perStage[stageId] = { totalTaskDurationSum, taskCount };
  }

  const histogram = coreCountHistogram(launches.subarray(0, intervalCount), finishes.subarray(0, intervalCount));
  let busyCoreMs = 0;
  for (let k = 0; k < histogram.length; k++) busyCoreMs += k * histogram[k];
  const peakConcurrentCores = histogram.length > 0 ? histogram.length - 1 : 0;

  return { coreHistogram: histogram, busyCoreMs, peakConcurrentCores, perStage };
}
