import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  cacheUtilization: {
    name: 'cache utilization',
    tag: 'CSTOR',
    family: 'cost',
    pitch: 'A cached dataset does not fit in memory or spills to disk.',
    region: 'reference',
    thresholdSummary: () => 'cached partitions evicted or spilled to disk',
    actionLabel: (f) => (f.variant === 'storageUnobserved' ? 'Enable block-update logging' : 'Increase cache memory'),
    genericRecommendation(f) {
      switch (f.variant) {
        case 'partialCache': return 'Increase executor memory or reduce the cached dataset size so more of it stays cached.';
        case 'diskSpillover': return 'Executor memory may be too small for this cached dataset: increase executor memory or reduce its size.';
      }
      return undefined;
    },
  },
} as const satisfies {
  cacheUtilization: FindingPresentation<'cacheUtilization'>;
};
