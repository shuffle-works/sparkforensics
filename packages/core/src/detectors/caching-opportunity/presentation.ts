import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  cachingOpportunity: {
    name: 'caching opportunity',
    tag: 'CACHE',
    family: 'cost',
    pitch: 'The same data is read more than once and is never cached.',
    thresholdSummary: () => 'a dataset re-read from source multiple times with no cache/persist',
    actionLabel: (f) => (f.variant === 'composite' ? 'Cache repeated result' : 'Cache shared table'),
    genericRecommendation: (f) => (f.variant === 'composite'
      ? 'Cache or persist the repeated join/union result so it is computed once instead of recomputed per query.'
      : 'Cache the shared DataFrame, or broadcast it if it is a small join lookup.'),
  },
} as const satisfies {
  cachingOpportunity: FindingPresentation<'cachingOpportunity'>;
};
