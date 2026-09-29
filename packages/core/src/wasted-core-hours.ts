// Wasted core-hours summary. Pure, worker-agnostic reducer over the same inputs
// the memoryUtilization detector's idle-cores math uses: capacity core-time vs.
// core-time that actually ran tasks. Feeds a report widget only, no detector.

import { computePeakConcurrentCores } from './core-count.ts';
import { MS_PER_CORE_HOUR } from './format-utils.ts';

const TOP_N = 5;

export interface WastedCoreHoursResult {
  totalCoreHours: number | null;
  usefulCoreHours: number | null;
  wastedCoreHours: number | null;
  totalCores: number | null;
  topStages: Array<{ stageId: number; coreMs: number }>;
}

const EMPTY: WastedCoreHoursResult = {
  totalCoreHours: null,
  usefulCoreHours: null,
  wastedCoreHours: null,
  totalCores: null,
  topStages: [],
};

interface RunAggregates {
  busyCoreMs?: number;
  perStage?: Record<string, { totalTaskDurationSum: number }>;
}

// `app`/`runAggregates` are nullable because real callers pass null (app is
// SparkAppInfo | null before parsing completes), which the guard below already
// tolerates. `resources` is on app's shape so the computePeakConcurrentCores
// pass-through type-checks; real app objects always carry it. An omitted
// `executorsRemoved` means no executor left, where peak cores equal the sum.
export function computeWastedCoreHours(
  app: { startTime?: number; endTime?: number | null; resources?: { executor?: { cores?: number } } } | null,
  executorsAdded: Array<{ executorId: string; timestamp: number; totalCores?: number }> | undefined = [],
  runAggregates: RunAggregates | null,
  executorsRemoved: Array<{ executorId: string; timestamp: number }> = [],
): WastedCoreHoursResult {
  // Nullish (not falsy) guard on times: a literal startTime:0 is valid.
  if (!runAggregates || app?.startTime == null || app?.endTime == null) return EMPTY;
  const appDurationMs = app.endTime - app.startTime;
  if (appDurationMs <= 0) return EMPTY;

  // Total cores: peak concurrent Executor-Added Total Cores, else peak executors ×
  // configured cores. Same capacity as the memoryUtilization detector, so an
  // executor replaced mid-run is not counted twice.
  const totalCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);
  if (totalCores <= 0) return EMPTY;

  const totalCoreHours = (totalCores * appDurationMs) / MS_PER_CORE_HOUR;
  const usefulCoreHours = (runAggregates.busyCoreMs ?? 0) / MS_PER_CORE_HOUR;
  // Clamp: totalCores can be a fallback estimate while busyCoreMs is measured
  // from task events, so the difference can dip below zero (same guard as
  // src/efficiency-model.js).
  const wastedCoreHours = Math.max(0, totalCoreHours - usefulCoreHours);

  const topStages = Object.entries(runAggregates.perStage ?? {})
    .map(([stageId, s]) => ({ stageId: Number(stageId), coreMs: s?.totalTaskDurationSum ?? 0 }))
    .sort((a, b) => b.coreMs - a.coreMs)
    .slice(0, TOP_N);

  return { totalCoreHours, usefulCoreHours, wastedCoreHours, totalCores, topStages };
}
