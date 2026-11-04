import type { FindingPresentation } from '../../finding-presentation.ts';
import { failureFix } from '../presentation-shared.ts';

export const presentation = {
  stageFailed: {
    name: 'failed stage',
    tag: 'SFAIL',
    family: 'reliability',
    pitch: 'A stage failed and took its job down with it.',
    thresholdSummary: () => 'a stage that failed outright',
    actionLabel: () => 'Inspect stage failure',
    genericRecommendation: (f) => failureFix(f) ?? 'Inspect the driver log for the failure reason and the job that triggered it.',
  },
} as const satisfies {
  stageFailed: FindingPresentation<'stageFailed'>;
};
