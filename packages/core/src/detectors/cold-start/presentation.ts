import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  coldStart: {
    name: 'cold start',
    tag: 'COLD',
    family: 'speed',
    pitch: 'The job waits for its first executors before any task can run.',
    thresholdSummary: (t) => `the first stage waiting over ${t.gapSeconds}s for an executor`,
    actionLabel: () => 'Pre-warm cluster',
    genericRecommendation: (f) => (f.dynamicAllocation === 'off'
      ? 'Keep a warm pool of idle executors: dynamic allocation is off, so no executor-count property applies.'
      : 'Keep a warm pool of idle executors, or if using dynamic allocation, raise the minimum/initial executor count so it does not scale up from zero.'),
  },
} as const satisfies {
  coldStart: FindingPresentation<'coldStart'>;
};
