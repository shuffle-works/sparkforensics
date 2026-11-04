import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  speculationWaste: {
    name: 'speculation waste',
    tag: 'SPEC',
    family: 'speed',
    pitch: 'Speculative copies of slow tasks use cores without finishing the stage sooner.',
    thresholdSummary: (t) => `${t.minWasted}+ discarded speculative attempts wasting at least ${t.minWasteMs / 1000}s`,
    actionLabel: () => 'Tune speculation settings',
    genericRecommendation: () => 'If task durations are naturally variable rather than genuine stragglers, consider tuning spark.speculation.multiplier/quantile.',
  },
} as const satisfies {
  speculationWaste: FindingPresentation<'speculationWaste'>;
};
