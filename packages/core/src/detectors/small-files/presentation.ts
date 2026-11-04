import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  smallFiles: {
    name: 'small files',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'A write produces many tiny files that slow every later read.',
    thresholdSummary: (t) => `over ${t.minFiles} files averaging under ${t.maxAvgFileSizeMB} MiB`,
    actionLabel: (f) => (f.direction === 'write' ? 'Coalesce output files' : 'Compact small files'),
    genericRecommendation: (f) => (f.direction === 'write'
      ? 'Repartition or coalesce before writing to raise the average file size.'
      : 'Compact the upstream output so fewer, larger files are produced.'),
  },
} as const satisfies {
  smallFiles: FindingPresentation<'smallFiles'>;
};
