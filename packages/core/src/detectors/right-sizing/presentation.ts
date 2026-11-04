import type { FindingPresentation } from '../../finding-presentation.ts';
import { shareLabel, idleCapacityRecommendation } from '../presentation-shared.ts';

export const presentation = {
  rightSizing: {
    name: 'right-sized cluster',
    tag: 'UTIL',
    family: 'cost',
    pitch: 'A smaller cluster would run the same stages in about the same time.',
    thresholdSummary: (t) => `the model finds the stages run within ${t.tolerancePct}% of their real time on at most ${shareLabel(t.maxCoreShare)} of the peak cores (model error under ${t.maxModelErrorPct}%)`,
    actionLabel: () => 'Right-size cluster',
    genericRecommendation: idleCapacityRecommendation,
  },
} as const satisfies {
  rightSizing: FindingPresentation<'rightSizing'>;
};
