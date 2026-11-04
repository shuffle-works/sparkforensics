import type { FindingPresentation } from '../../finding-presentation.ts';
import { partitionAdviceKind } from '../presentation-shared.ts';

export const presentation = {
  stageSlowness: {
    name: 'slow stage',
    tag: 'SLOW',
    family: 'speed',
    pitch: 'A stage runs for a long stretch of the job with no single cause flagged on it.',
    thresholdSummary: () => 'a stage running far longer than its peers, not attributable to a single slow host',
    actionLabel: () => 'Profile slow stage',
    genericRecommendation(f) {
      if (f.reads === 'input') return 'Often too few or too uneven input partitions: check input file sizes and lower spark.sql.files.maxPartitionBytes, or look for a large per-task data volume driving heavy spill.';
      if (f.reads === 'other') return 'Check what the stage computes and for a large per-task data volume driving heavy spill.';
      const spill = 'or check for a large per-task data volume driving heavy shuffle and spill.';
      switch (partitionAdviceKind(f)) {
        case 'aqe': return `Often a partition-count problem: AQE coalesced the shuffle, so lower spark.sql.adaptive.advisoryPartitionSizeInBytes to get more tasks, ${spill}`;
        case 'code': return `Often a partition-count problem: raise this stage's own partition count (its repartition(n) or RDD parallelism), ${spill}`;
        default: return `Often a partition-count problem: raise spark.sql.shuffle.partitions, ${spill}`;
      }
    },
  },
} as const satisfies {
  stageSlowness: FindingPresentation<'stageSlowness'>;
};
