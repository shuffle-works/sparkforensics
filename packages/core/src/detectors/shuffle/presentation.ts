import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  shuffle: {
    name: 'shuffle I/O',
    tag: 'SHFL',
    family: 'speed',
    pitch: 'Moving data between executors takes more time than computing it.',
    thresholdSummary: (t) => `stage shuffle read above ${t.minBytes / 1048576} MiB`,
    actionLabel: () => 'Reduce shuffle size',
    genericRecommendation: (f) => {
      switch (f.partitions) {
        case 'sufficient': return 'The tasks are already a good size, so more partitions will not help: use a broadcast join for the smaller side.';
        case 'aqeCoalesced': return 'AQE coalesced the shuffle: lower spark.sql.adaptive.advisoryPartitionSizeInBytes, or use a broadcast join for the smaller side.';
        case 'ownPartitioning': return "spark.sql.shuffle.partitions did not size this stage, so raise its own partition count (its repartition(n) or RDD parallelism), or use a broadcast join for the smaller side.";
        default: return 'Raise spark.sql.shuffle.partitions, or use a broadcast join for the smaller side.';
      }
    },
  },
} as const satisfies {
  shuffle: FindingPresentation<'shuffle'>;
};
