import type { FindingPresentation } from '../../finding-presentation.ts';
import { shareLabel } from '../presentation-shared.ts';

export const presentation = {
  jobFailureRate: {
    name: 'job failure rate',
    tag: 'JOBS',
    family: 'reliability',
    pitch: 'A large share of the jobs in the application fail.',
    thresholdSummary: (t) => `at least ${shareLabel(t.infoRate)} of jobs failing`,
    actionLabel: () => 'Investigate failed jobs',
    genericRecommendation: () => 'Inspect the driver log for the failed job(s) and the stage failures that triggered them.',
  },
} as const satisfies {
  jobFailureRate: FindingPresentation<'jobFailureRate'>;
};
