import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  duplicatePlanSubtree: {
    name: 'duplicate plan subtree',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'The query plan computes the same subtree more than once.',
    thresholdSummary: () => 'the same physical plan subtree executed more than once',
    actionLabel: () => 'Dedupe repeated subtree',
    // isExchangeRoot isn't a Finding field, so one sentence covers both cases.
    genericRecommendation: (f) => (f.readsDifferentVersions
      ? 'The repeats read different versions of the same Delta table, which no cache can serve: confirm both versions are meant to be read.'
      : 'Check whether the repeated subtree could be computed once and reused, or cache/persist the shared computation.'),
  },
} as const satisfies {
  duplicatePlanSubtree: FindingPresentation<'duplicatePlanSubtree'>;
};
