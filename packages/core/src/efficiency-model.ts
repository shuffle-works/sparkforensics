// §5 Efficiency/wastage model. DESIGN SPIKE:
// decomposes available compute-hours into driver-bound vs executor-bound waste, plus two floors.
import { computeWallClock } from './wall-clock.ts';
import { computePeakConcurrentCores } from './core-count.ts';
import type { ExecutorEvent, RunAggregates, SparkAppInfo } from './types.ts';

export function computeEfficiencyModel({ app, stages, executorsAdded, executorsRemoved, runAggregates }: {
  app: SparkAppInfo | null;
  stages: Map<number, unknown>;
  executorsAdded: ExecutorEvent[];
  executorsRemoved: ExecutorEvent[];
  runAggregates: RunAggregates | null;
}): {
  availableComputeHours: number;
  driverWasteHours: number;
  executorWasteHours: number;
  wastagePct: number | null;
  floorZeroSkewMs: number;
  dominantWaste: 'driver' | 'executor' | null;
} {
  // Capacity is the peak concurrent core count, the one the utilization and idle-cores detectors
  // use, so the Unused core time tile matches the verdict's idle figure. Summing every addition
  // (computeTotalCores) counts a replaced executor's cores alongside its replacement's.
  // `app ?? {}`: callers tolerate a null app (malformed logs); `app!` would crash on app.resources.
  const totalCores = computePeakConcurrentCores(app ?? {}, executorsAdded, executorsRemoved);
  const appDurationMs = (app?.endTime ?? 0) - (app?.startTime ?? 0);
  const wc = computeWallClock(app, stages as Map<number, { submittedAt?: number; completedAt?: number }>);

  const availableComputeHours = totalCores * (appDurationMs / 3600000);

  // Driver-bound: cores idle during startup + gaps + idle (no active stage).
  const driverIdleMs = wc.startup + wc.gaps + wc.idle;
  const driverWasteHours = totalCores * (driverIdleMs / 3600000);

  // Executor-bound: allocated capacity beyond busy cores during stagesActive. Tasks only run in
  // active windows, so whole-run busyCoreMs already lives inside stagesActive.
  const allocatedActiveCoreMs = totalCores * wc.stagesActive;
  const busyCoreMs = runAggregates?.busyCoreMs ?? 0;
  const executorWasteHours = Math.max(0, allocatedActiveCoreMs - busyCoreMs) / 3600000;

  const wastageHours = driverWasteHours + executorWasteHours;
  const wastagePct = availableComputeHours > 0 ? Math.round(wastageHours / availableComputeHours * 100) : null;

  let totalTaskMs = 0;
  const perStage = runAggregates?.perStage ?? {};
  for (const k of Object.keys(perStage)) totalTaskMs += perStage[k].totalTaskDurationSum;
  const floorZeroSkewMs = totalCores > 0 ? totalTaskMs / totalCores : 0;

  let dominantWaste: 'driver' | 'executor' | null = null;
  if (driverWasteHours > 0 || executorWasteHours > 0) {
    dominantWaste = driverWasteHours >= executorWasteHours ? 'driver' : 'executor';
  }

  return {
    availableComputeHours, driverWasteHours, executorWasteHours, wastagePct,
    floorZeroSkewMs, dominantWaste,
  };
}
