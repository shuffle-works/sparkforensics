import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  unprunedScan: {
    name: 'unpruned partitioned scan',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'A filtered scan with no partition filter reads every partition of the table.',
    thresholdSummary: (t) => `a filtered scan of a partitioned table with no partition filter that read at least ${t.minPartitionsRead} partitions and ${t.minBytesRead / 1073741824} GiB`,
    actionLabel: () => 'Filter on partition columns',
    genericRecommendation: () => 'Add a filter on a partition column, for example the date the table is partitioned by, so Spark can skip partitions.',
  },
} as const satisfies {
  unprunedScan: FindingPresentation<'unprunedScan'>;
};
