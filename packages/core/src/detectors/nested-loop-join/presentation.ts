import type { FindingPresentation } from '../../finding-presentation.ts';
import { groupThousands } from '../presentation-shared.ts';

export const presentation = {
  nestedLoopJoin: {
    name: 'nested loop join',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'A join with no usable key compares every row with every row and multiplies its output.',
    thresholdSummary: (t) => `a nested-loop or cartesian join with over ${groupThousands(t.minOutputRows)} output rows, at least ${t.minExpansion}x its larger input`,
    actionLabel: (f) => (f.condition == null ? 'Confirm cross join' : 'Add an equi-join key'),
    genericRecommendation: (f) => (f.condition == null
      ? 'Confirm the cross join is intended, or add a join key so the rows are matched instead of multiplied.'
      : 'Add an equi-join key so Spark can use a hash or sort-merge join; for a range condition, bucket the range and join on the bucket as well.'),
  },
} as const satisfies {
  nestedLoopJoin: FindingPresentation<'nestedLoopJoin'>;
};
