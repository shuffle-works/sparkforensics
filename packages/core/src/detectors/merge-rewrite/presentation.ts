import type { FindingPresentation } from '../../finding-presentation.ts';
import { shareLabel, groupThousands } from '../presentation-shared.ts';

export const presentation = {
  mergeRewrite: {
    name: 'MERGE rewrite',
    tag: 'PLAN',
    family: 'plan',
    pitch: 'A Delta MERGE rewrites most of the rows it did not change.',
    thresholdSummary: (t) => `a MERGE that rewrote at least ${groupThousands(t.minCopiedRows)} unmodified rows, at least ${t.minCopiedToChangedRatio}x the rows it changed, or kept ${shareLabel(t.minFilesKeptShare)} of at least ${t.minTargetFiles} target files after skipping while changing at most ${shareLabel(t.maxTouchedPartitionShare)} of the partitions it scanned`,
    actionLabel: (f) => (f.rule === 'weakSkipping' ? 'Prune MERGE target files' : 'Filter MERGE source'),
    genericRecommendation: (f) => (f.rule === 'weakSkipping'
      ? 'Repeat the target partition range in the MERGE condition so Delta can prune files, and check the target\'s file layout.'
      : 'Filter the MERGE source to the rows that changed (for example with a row-hash anti-join), repeat the target partition range in the MERGE condition so Delta can prune files, and check the target\'s file layout.'),
  },
} as const satisfies {
  mergeRewrite: FindingPresentation<'mergeRewrite'>;
};
