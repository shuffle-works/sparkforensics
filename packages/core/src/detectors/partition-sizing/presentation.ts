import type { FindingPresentation } from '../../finding-presentation.ts';
import { switchAlreadyOn, skewJoinGeneric } from '../presentation-shared.ts';

export const presentation = {
  partitionSizing: {
    name: 'partition sizing',
    tag: 'PART',
    family: 'speed',
    pitch: 'Shuffle partitions are too large, too uneven or too few, so tasks spill or fail.',
    thresholdSummary: (t) => `a shuffle partition over ${t.skewRatio}× the median or over ${t.maxPartBytes / 1073741824} GiB, or ${t.lowParTotalBytes / 1073741824} GiB of shuffle on ${t.lowParMaxTasks} tasks or fewer`,
    actionLabel(f) {
      switch (f.rule) {
        case 'shufflePartitionSkew': return 'Fix skewed partition';
        case 'lowShuffleParallelism': return 'Add shuffle partitions';
        case 'maxPartitionTooBig': return 'Repartition oversized data';
      }
      return undefined;
    },
    genericRecommendation(f) {
      switch (f.rule) {
        case 'shufflePartitionSkew':
          if (f.singleKey) return 'Almost all rows share one key (often NULL or a constant), so more partitions will not help: broadcast the small side with a hint, filter or split out the NULL rows, or give the NULL rows a random key.';
          return skewJoinGeneric(f, 'For join skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.');
        case 'lowShuffleParallelism':
          if (f.partitions === 'aqeCoalesced') return 'AQE coalesced the shuffle into few tasks: lower spark.sql.adaptive.advisoryPartitionSizeInBytes so each partition is smaller.';
          return switchAlreadyOn(f, 'spark.sql.shuffle.partitions')
          ? "spark.sql.shuffle.partitions did not size this stage, so raise its own partition count (its repartition(n) or RDD parallelism) so each partition is smaller."
          : 'Raise spark.sql.shuffle.partitions so each partition is smaller.';
        case 'maxPartitionTooBig': return 'Repartition to break up the oversized partition before this stage.';
      }
      return undefined;
    },
  },
} as const satisfies {
  partitionSizing: FindingPresentation<'partitionSizing'>;
};
