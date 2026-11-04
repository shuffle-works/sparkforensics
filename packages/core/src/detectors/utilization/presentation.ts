import type { FindingPresentation } from '../../finding-presentation.ts';
import { shareLabel, idleCapacityRecommendation } from '../presentation-shared.ts';

export const presentation = {
  utilization: {
    name: 'executor utilization',
    tag: 'UTIL',
    family: 'cost',
    pitch: 'Executors sit idle for much of the run, so the cluster is larger than the work needs.',
    region: 'reference',
    thresholdSummary: (t) => `average executor utilization below ${shareLabel(t.minUtil)}`,
    actionLabel: () => 'Reduce cluster size',
    genericRecommendation: idleCapacityRecommendation,
  },
} as const satisfies {
  utilization: FindingPresentation<'utilization'>;
};
