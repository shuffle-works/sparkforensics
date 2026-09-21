// Whole-run aggregation pass. Runs INSIDE parser-worker.js over the retained
// per-task launch/finish timestamps in taskStore, so raw task data never
// reaches the main thread: only the compact summary below is posted. Pure and
// worker-agnostic so it is unit-testable without a Worker.
//
// Uses computeCoreTimeSeries in coreCount mode (O(n log n)) to derive the
// busy-core histogram; the time-bucket mode is intentionally NOT used here
// because it is O(buckets × segments) and a whole run can hold millions of
// tasks (see core-time-series.js PERF note).

import { FIELDS } from './stage-quantiles.ts';
import { computeCoreTimeSeries } from './core-time-series.ts';

export function computeRunAggregates(taskStore: Map<number, Float64Array>): {
  coreHistogram: number[];
  busyCoreMs: number;
  peakConcurrentCores: number;
  perStage: Record<string, { totalTaskDurationSum: number; taskCount: number }>;
} {
  const intervals: Array<{ launch: number; finish: number }> = [];
  const perStage: Record<string, { totalTaskDurationSum: number; taskCount: number }> = {};
  for (const [stageId, arr] of taskStore) {
    const taskCount = arr.length / FIELDS.STRIDE;
    let totalTaskDurationSum = 0;
    for (let i = 0; i < taskCount; i++) {
      const base = i * FIELDS.STRIDE;
      const launch = arr[base + FIELDS.LAUNCH_TIME];
      const finish = arr[base + FIELDS.FINISH_TIME];
      totalTaskDurationSum += arr[base + FIELDS.DURATION];
      if (finish > launch) intervals.push({ launch, finish });
    }
    perStage[stageId] = { totalTaskDurationSum, taskCount };
  }

  // bucketBy: 'coreCount' always yields the coreCount branch of the union;
  // narrow explicitly since the callee's return type doesn't correlate to
  // the literal `bucketBy` argument.
  const { histogram } = computeCoreTimeSeries(intervals, { bucketBy: 'coreCount' }) as { mode: 'coreCount'; histogram: number[] };
  let busyCoreMs = 0;
  for (let k = 0; k < histogram.length; k++) busyCoreMs += k * histogram[k];
  const peakConcurrentCores = histogram.length > 0 ? histogram.length - 1 : 0;

  return { coreHistogram: histogram, busyCoreMs, peakConcurrentCores, perStage };
}
