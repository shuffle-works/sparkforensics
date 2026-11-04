import type { FindingPresentation } from '../../finding-presentation.ts';
import { partitionAdviceKind } from '../presentation-shared.ts';

export const presentation = {
  spill: {
    name: 'spill',
    tag: 'SPILL',
    family: 'speed',
    pitch: 'Tasks run out of execution memory and write intermediate data to disk.',
    thresholdSummary: (t) => `single-task disk spill above ${t.singleTaskDiskGiB} GiB`,
    actionLabel: () => 'Reduce spill',
    // The skew/volume classification isn't a Finding field, so one sentence covers both.
    genericRecommendation(f) {
      const skewFirst = 'If the spill is skew-driven, fix task skew first: adding memory will not help. Otherwise';
      const has = (key: string) => f.remediation?.some((r) => r.kind === 'conf' && r.key === key) ?? false;
      const cores = has('spark.executor.cores') ? ', lower spark.executor.cores so each task gets more memory,' : '';
      if (f.reads != null && f.reads !== 'shuffle') return `${skewFirst}${cores} increase executor memory or process less data per task.`;
      if (has('spark.sql.adaptive.advisoryPartitionSizeInBytes')) {
        const floor = has('spark.sql.adaptive.coalescePartitions.minPartitionNum') ? ' or raise spark.sql.adaptive.coalescePartitions.minPartitionNum' : '';
        const countKey = ['spark.sql.adaptive.coalescePartitions.initialPartitionNum', 'spark.sql.shuffle.partitions'].find(has);
        const count = countKey ? ` or raise ${countKey}` : '';
        return `${skewFirst} lower spark.sql.adaptive.advisoryPartitionSizeInBytes so AQE's merged partitions are smaller${floor}${count}${cores} or increase executor memory.`;
      }
      switch (partitionAdviceKind(f)) {
        case 'code': return `${skewFirst} raise this stage's own partition count (its repartition(n) or RDD parallelism)${cores} or increase executor memory.`;
        default: return `${skewFirst} raise spark.sql.shuffle.partitions${cores} or increase executor memory.`;
      }
    },
  },
} as const satisfies {
  spill: FindingPresentation<'spill'>;
};
