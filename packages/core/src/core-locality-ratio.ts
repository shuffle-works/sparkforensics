// Whole-run core-usage-locality ratio: non-local task share across every stage's localityStats.
// Locality tiers (Spark, best to worst): PROCESS_LOCAL > NODE_LOCAL > NO_PREF > RACK_LOCAL > ANY.
// NO_PREF is not a locality failure (shuffle-read stages report it, no location preference for a
// shuffle fetch), so it stays in the denominator but never the numerator.
const NON_LOCAL_TIERS = new Set(['RACK_LOCAL', 'ANY']);
const TOP_N = 5;
const MIN_TASKS_PER_STAGE = 10;

const EMPTY = { totalTasks: null, nonLocalTasks: null, ratio: null, topStages: [] };

export function computeCoreLocalityRatio(stages: Array<{id: number; localityStats?: {locality: string; count: number}[]}>, { minTasksPerStage = MIN_TASKS_PER_STAGE, topN = TOP_N }: {minTasksPerStage?: number; topN?: number} = {}): {totalTasks: number|null; nonLocalTasks: number|null; ratio: number|null; topStages: Array<{stageId: number; nonLocalTasks: number; taskCount: number; ratio: number}>} {
  if (!Array.isArray(stages) || stages.length === 0) return EMPTY;

  let totalTasks = 0;
  let nonLocalTasks = 0;
  const perStage = [];

  for (const stage of stages) {
    const localityStats = stage?.localityStats;
    if (!Array.isArray(localityStats) || localityStats.length === 0) continue;

    let stageTotal = 0;
    let stageNonLocal = 0;
    for (const { locality, count } of localityStats) {
      if (!Number.isFinite(count)) continue;
      stageTotal += count;
      if (NON_LOCAL_TIERS.has(locality)) stageNonLocal += count;
    }
    totalTasks += stageTotal;
    nonLocalTasks += stageNonLocal;

    if (stageTotal >= minTasksPerStage) {
      perStage.push({
        stageId: stage.id,
        nonLocalTasks: stageNonLocal,
        taskCount: stageTotal,
        ratio: stageNonLocal / stageTotal,
      });
    }
  }

  if (totalTasks === 0) return EMPTY;

  const topStages = perStage.sort((a, b) => b.nonLocalTasks - a.nonLocalTasks).slice(0, topN);

  return { totalTasks, nonLocalTasks, ratio: nonLocalTasks / totalTasks, topStages };
}
