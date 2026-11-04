import type { FindingPresentation } from '../../finding-presentation.ts';
import { partitionAdviceKind } from '../presentation-shared.ts';

export const presentation = {
  tinyTask: {
    name: 'tiny tasks',
    tag: 'TINY',
    family: 'speed',
    pitch: 'Very short tasks spend more time being scheduled than running.',
    thresholdSummary: (t) => `${t.minTasks}+ tasks with a median of ${t.maxP50}ms or less and a P95 of ${t.maxP95}ms or less`,
    actionLabel: () => 'Coalesce small tasks',
    genericRecommendation(f) {
      if (f.reads != null && f.reads !== 'shuffle') return 'Scheduler overhead may dominate: coalesce down to fewer, larger tasks.';
      switch (partitionAdviceKind(f)) {
        case 'aqe': return 'Scheduler overhead may dominate: AQE already coalesced the shuffle, so set spark.sql.adaptive.coalescePartitions.parallelismFirst to false or raise spark.sql.adaptive.advisoryPartitionSizeInBytes, or coalesce down to fewer, larger tasks.';
        case 'code': return "Scheduler overhead may dominate: this stage's own repartition(n) or RDD parallelism sized it, so lower that count or coalesce down to fewer, larger tasks.";
        default: return 'Scheduler overhead may dominate: lower spark.sql.shuffle.partitions, or coalesce down to fewer, larger tasks.';
      }
    },
  },
} as const satisfies {
  tinyTask: FindingPresentation<'tinyTask'>;
};
