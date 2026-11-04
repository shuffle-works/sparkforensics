import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  incompleteRun: {
    name: 'incomplete run',
    tag: 'INCMP',
    family: 'setup',
    pitch: 'The event log ends before the application did, so every number is a partial view.',
    thresholdSummary: () => 'an event log missing its terminal ApplicationEnd event',
    actionLabel: () => undefined,
    genericRecommendation: () => undefined,
  },
} as const satisfies {
  incompleteRun: FindingPresentation<'incompleteRun'>;
};
