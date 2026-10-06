// Wasted core-hours summary. Pure, worker-agnostic reducer over the same inputs
// the memoryUtilization detector's idle-cores math uses: allocated core-time vs.
// core-time that actually ran tasks. Feeds a report widget only, no detector.

import { allocatedCoreMs } from './allocation.ts';
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
// `executorsRemoved` means no executor left.
export function computeWastedCoreHours(
  app: { startTime?: number; endTime?: number | null; config?: Record<string, string>; resources?: { executor?: { cores?: number } } } | null,
  executorsAdded: Array<{ executorId: string; timestamp: number; totalCores?: number }> | undefined = [],
  runAggregates: RunAggregates | null,
  executorsRemoved: Array<{ executorId: string; timestamp: number }> = [],
): WastedCoreHoursResult {
  // Nullish (not falsy) guard on times: a literal startTime:0 is valid.
  if (!runAggregates || app?.startTime == null || app?.endTime == null) return EMPTY;
  const appDurationMs = app.endTime - app.startTime;
  if (appDurationMs <= 0) return EMPTY;

  // Capacity is the run's allocation (cores x time alive), the same as the idle findings. The
  // application end is set here, so the allocation never needs the stages to find where a log stops.
  const allocatedMs = allocatedCoreMs({ app, stages: new Map(), executors: { added: executorsAdded, removed: executorsRemoved } });
  if (allocatedMs == null) return EMPTY;
  // Peak concurrent cores, reported as the cluster size: an executor replaced mid-run counts once.
  const totalCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);

  const totalCoreHours = allocatedMs / MS_PER_CORE_HOUR;
  const usefulCoreHours = (runAggregates.busyCoreMs ?? 0) / MS_PER_CORE_HOUR;
  // Clamp: busyCoreMs is measured from task events while the allocation comes from executor
  // events, so the difference can dip below zero (same guard as efficiency-model.ts).
  const wastedCoreHours = Math.max(0, totalCoreHours - usefulCoreHours);

  const topStages = Object.entries(runAggregates.perStage ?? {})
    .map(([stageId, s]) => ({ stageId: Number(stageId), coreMs: s?.totalTaskDurationSum ?? 0 }))
    .sort((a, b) => b.coreMs - a.coreMs)
    .slice(0, TOP_N);

  return { totalCoreHours, usefulCoreHours, wastedCoreHours, totalCores, topStages };
}
