import { presentationOf } from './finding-presentation.ts';
import { pathBasename } from './format-utils.ts';
import type { Finding, FindingOf } from './types.ts';

/** A generic, type-level recommendation sentence for a finding: the shape of the fix, with no
 * instance data (numbers, stage ids, host names, file counts, config values), from its type's
 * FINDING_PRESENTATION row.
 *
 * Used for a multi-finding group's muted description line (TypeGroupRow in FixTheseFirst.tsx),
 * where the highest-impact member's own `recommendation` (real numbers, one stage) would
 * misrepresent a summed-impact trailing stat covering every member. Undefined where the row has no
 * sentence for the finding; the caller shows no muted line rather than guess. */
export function coreFindingGenericRecommendation(finding: Finding): string | undefined {
  return presentationOf(finding.type)?.genericRecommendation(finding);
}

/** What a duplicatePlanSubtree finding measured, for the detector's recommendation and the
 * Redundant Plan Subtree row, which shows it beside the fix its card states once. */
export function duplicateSubtreeDetail(f: { subtreeSize: number; rootName: string; value?: number; sampleRelation: string | null }): string {
  const touching = f.sampleRelation ? ` (touching ${f.sampleRelation})` : '';
  return `A ${f.subtreeSize}-node subtree rooted at ${pathBasename(f.rootName)} repeats ${f.value}x in this plan${touching}`;
}

export const DUPLICATE_SUBTREE_DIFFERING_NOTE = 'Their filters, columns or scanned tables differ, so the repeats may compute different data.';

/** Reader-facing names for slowHost's per-executor dimensions, for the detector's recommendation
 * and the Slow Executor Host row. */
export const SLOW_HOST_DIMENSION_LABEL: Record<NonNullable<FindingOf<'slowHost'>['dimension']>, string> = {
  taskTime: 'task time',
  inputBytes: 'input read',
  shuffleBytes: 'shuffle read and write',
  storageMemory: 'storage memory',
};
