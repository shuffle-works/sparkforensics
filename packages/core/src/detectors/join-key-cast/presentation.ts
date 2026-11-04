import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  joinKeyCast: {
    name: 'cast on a join key',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'A cast on a join key forces another shuffle.',
    thresholdSummary: () => 'a shuffled join with a cast in its key, followed by an exchange on the uncast column',
    actionLabel: () => 'Match join key types',
    genericRecommendation: () => 'Give both join columns the same type before the join, so Spark adds no cast to the key and the join output keeps its partitioning.',
  },
} as const satisfies {
  joinKeyCast: FindingPresentation<'joinKeyCast'>;
};
