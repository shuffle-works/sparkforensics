import type { FindingPresentation } from '../../finding-presentation.ts';
import { failureFix } from '../presentation-shared.ts';

export const presentation = {
  retryWaste: {
    name: 'retry waste',
    tag: 'RETRY',
    family: 'reliability',
    pitch: 'Failed attempts are retried, and their lost time is added to the run.',
    thresholdSummary: (t) => `${t.minWasted}+ retried attempts wasting at least ${t.minWasteMs / 1000}s`,
    actionLabel: () => 'Investigate retry cause',
    genericRecommendation: (f) => failureFix(f) ?? 'Investigate executor loss or fetch failures behind the retried attempts.',
  },
} as const satisfies {
  retryWaste: FindingPresentation<'retryWaste'>;
};
