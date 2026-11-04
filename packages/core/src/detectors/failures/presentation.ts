import type { FindingPresentation } from '../../finding-presentation.ts';
import { shareLabel, failureFix } from '../presentation-shared.ts';

export const presentation = {
  failures: {
    name: 'failed tasks',
    tag: 'FAIL',
    family: 'reliability',
    pitch: 'Tasks fail and run again, so the cluster pays for the same work twice.',
    thresholdSummary: (t) => `over ${shareLabel(t.warnRate)} of a stage's tasks failing`,
    actionLabel: () => 'Investigate task failures',
    genericRecommendation: (f) => failureFix(f) ?? 'Investigate driver logs for executor instability or data-driven errors.',
  },
} as const satisfies {
  failures: FindingPresentation<'failures'>;
};
