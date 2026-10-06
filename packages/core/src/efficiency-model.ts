// §5 Efficiency/wastage model. DESIGN SPIKE:
// decomposes available compute-hours into driver-bound vs executor-bound waste, plus two floors.
import { stageWindows } from './wall-clock.ts';
import { allocatedCoreMs, allocatedCoreMsWithin } from './allocation.ts';
import { computePeakConcurrentCores } from './core-count.ts';
import type { ExecutorEvent, RunAggregates, SparkAppInfo } from './types.ts';

export function computeEfficiencyModel({ app, stages, executorsAdded, executorsRemoved, runAggregates }: {
  app: SparkAppInfo | null;
  stages: Map<number, { submittedAt?: number; completedAt?: number }>;
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
  // Capacity is the run's allocation (cores x time alive, metrics.allocation.coreHours), the one the
  // utilization and idle-cores detectors use, so the Unused core time tile matches the verdict's
  // idle figure. Peak concurrent cores times the whole run would count cores the run never held
  // under dynamic allocation. Null without executor cores: no capacity, so no figure.
  const input = { app, stages, executors: { added: executorsAdded, removed: executorsRemoved } };
  const allocatedMs = allocatedCoreMs(input);
  // Split by where the allocated cores were held, from the same alive intervals: inside the union
  // of the stages' windows, or outside it (startup, gaps between stages, after the last stage).
  // Executors that join after startup hold no cores there, so spreading the allocation evenly
  // over the run would bill the driver for cores that never existed.
  const allocatedActiveCoreMs = allocatedMs == null ? 0 : allocatedCoreMsWithin(input, stageWindows(stages)) ?? 0;

  const availableComputeHours = (allocatedMs ?? 0) / 3600000;

  // Driver-bound: cores held while no stage was active (startup, gaps, idle).
  const driverWasteHours = Math.max(0, (allocatedMs ?? 0) - allocatedActiveCoreMs) / 3600000;

  // Executor-bound: allocated capacity beyond busy cores during stagesActive. Tasks only run in
  // active windows, so whole-run busyCoreMs already lives inside stagesActive.
  const busyCoreMs = runAggregates?.busyCoreMs ?? 0;
  const executorWasteHours = Math.max(0, allocatedActiveCoreMs - busyCoreMs) / 3600000;

  const wastageHours = driverWasteHours + executorWasteHours;
  const wastagePct = availableComputeHours > 0 ? Math.round(wastageHours / availableComputeHours * 100) : null;

  let totalTaskMs = 0;
  const perStage = runAggregates?.perStage ?? {};
  for (const k of Object.keys(perStage)) totalTaskMs += perStage[k].totalTaskDurationSum;
  // The floor is the least time the work takes on the widest the cluster ever was: peak concurrent
  // cores (not the allocation), summing every addition (computeTotalCores) would count a replaced
  // executor's cores alongside its replacement's. `app ?? {}`: callers tolerate a null app
  // (malformed logs); `app!` would crash on app.resources.
  const totalCores = computePeakConcurrentCores(app ?? {}, executorsAdded, executorsRemoved);
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
