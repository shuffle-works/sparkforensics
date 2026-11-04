import type { FindingPresentation } from '../../finding-presentation.ts';
import { skewJoinGeneric } from '../presentation-shared.ts';

export const presentation = {
  skew: {
    name: 'task skew',
    tag: 'SKEW',
    family: 'speed',
    pitch: 'One slow task holds a whole stage back while the rest of the cluster waits.',
    thresholdSummary: (t) => `P95 task time over ${t.ratioWarn}× the median (the longest task on stages under ${t.minTasksForP95} tasks), and the slow tasks read correspondingly more data`,
    actionLabel: () => 'Fix task skew',
    genericRecommendation: (f) => skewJoinGeneric(f,
      'For join-driven skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.'),
  },
} as const satisfies {
  skew: FindingPresentation<'skew'>;
};
