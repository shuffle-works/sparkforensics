import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  gc: {
    name: 'GC pressure',
    tag: 'GC',
    family: 'speed',
    pitch: 'Executors lose time to garbage collection instead of running tasks.',
    thresholdSummary: (t) => `GC above ${t.warnPct100}% (or below ${t.lowInfoPct100}%) of executor run time`,
    actionLabel: (f) => (f.direction === 'low' ? 'Right-size executor memory' : 'Reduce GC pressure'),
    genericRecommendation: (f) => (f.direction === 'low'
      ? 'Memory may be over-provisioned here: consider reducing spark.executor.memory for cost savings.'
      : 'Reduce object creation, use primitive types, avoid UDFs, or increase executor memory to cut GC time.'),
  },
} as const satisfies {
  gc: FindingPresentation<'gc'>;
};
