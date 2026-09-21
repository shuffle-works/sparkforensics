// §4 What-if executor-scaling simulator.
// DESIGN SPIKE: the makespan model is a first-cut approximation and is NOT
// validated against ground truth (a single event log only ever observes one
// scale). Every prediction ships with a Model Error confidence indicator.
//
// Builds on computeCoreTimeSeries' clamp conceptually, but operates on the
// worker-posted per-stage aggregates (runAggregates.perStage) so raw task data
// never reaches the main thread.
import { computeWallClock } from './wall-clock.ts';
import { computeTotalCores } from './core-count.ts';
import type { ExecutorEvent, RunAggregates, SparkAppInfo } from './types.ts';

const TEST_PERCENTAGES: number[] = [10, 20, 50, 80, 100, 110, 120, 150, 200, 300, 400, 500];

// Idealized makespan: total task-time spread over min(cores, taskCount) cores.
export function estimatedStageDurationAtCores(totalTaskDurationSum: number, taskCount: number, cores: number): number {
  if (taskCount <= 0 || cores <= 0) return 0;
  return totalTaskDurationSum / Math.min(cores, taskCount);
}

// Sum estimated per-stage durations at N cores. Idealized: ignores scheduling
// overhead, locality, shuffle-fetch contention (all captured in the real run's
// actual duration at current scale, hence Model Error).
function estimatedTotalAtCores(perStage: Record<string, { totalTaskDurationSum: number; taskCount: number }>, cores: number): number {
  let sum = 0;
  for (const stageId of Object.keys(perStage)) {
    const { totalTaskDurationSum, taskCount } = perStage[stageId];
    sum += estimatedStageDurationAtCores(totalTaskDurationSum, taskCount, cores);
  }
  return sum;
}

export function simulateScaling({ app, stages, runAggregates, executorsAdded }: {
  app: SparkAppInfo | null;
  stages: Map<number, unknown>;
  runAggregates: RunAggregates | null;
  executorsAdded: ExecutorEvent[];
}): {
  baselineCores: number;
  testPercentages: number[];
  predictions: Array<{ pct: number; cores: number; estMakespanMs: number }>;
  modelErrorPct: number | null;
} {
  const perStage = runAggregates?.perStage ?? {};
  // `app ?? {}`: computeTotalCores falls back to the executor-derived core sum
  // when `resources` is absent, and a null `app` (malformed log, no
  // ApplicationStart) is real here; `app!` would crash on `app.resources`.
  // `executorsAdded` cast: computeTotalCores only reads `totalCores`, present on
  // ExecutorAddedEvent (the only kind passed here) but not on the union type.
  const baselineCores = computeTotalCores(app ?? {}, executorsAdded as Array<{ totalCores?: number }>);
  const wc = computeWallClock(app, stages as Map<number, { submittedAt?: number; completedAt?: number }>);
  const observedActiveMs = wc.stagesActive;

  // Model Error: predicted-at-baseline vs. observed stages-active wall-clock.
  const predictedAtBaseline = baselineCores > 0 ? estimatedTotalAtCores(perStage, baselineCores) : 0;
  const modelErrorPct = observedActiveMs > 0
    ? Math.round(Math.abs(predictedAtBaseline - observedActiveMs) / observedActiveMs * 100)
    : null;

  // Scale factor projects the idealized sum onto the observed active wall-clock,
  // so predictions are relative to the real run rather than the raw idealization.
  const scale = predictedAtBaseline > 0 ? observedActiveMs / predictedAtBaseline : 1;

  const predictions = TEST_PERCENTAGES.map(pct => {
    const cores = Math.max(1, Math.round(baselineCores * pct / 100));
    const estMakespanMs = Math.round(estimatedTotalAtCores(perStage, cores) * scale);
    return { pct, cores, estMakespanMs };
  });

  return { baselineCores, testPercentages: TEST_PERCENTAGES, predictions, modelErrorPct };
}
