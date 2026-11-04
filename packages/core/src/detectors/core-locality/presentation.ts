import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  coreLocality: {
    name: 'core locality',
    tag: 'LOCAL',
    family: 'cost',
    pitch: 'Tasks often run away from the data they read.',
    region: 'reference',
    thresholdSummary: () => 'task placement missing data-local core assignment',
    actionLabel: () => 'Fix data locality',
    genericRecommendation: (f) => (f.remediation != null && !f.remediation.some((r) => r.kind === 'conf' && r.key === 'spark.locality.wait')
      ? 'No task in the stages with non-local tasks reached process- or node-local placement, so a longer spark.locality.wait only delays each task: run executors on the hosts that hold the data.'
      : 'Raise spark.locality.wait so the scheduler waits longer for a local slot, or run executors on the hosts that hold the data.'),
  },
} as const satisfies {
  coreLocality: FindingPresentation<'coreLocality'>;
};
