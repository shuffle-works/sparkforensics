import { presentationOf } from './finding-presentation.ts';
import type { Finding } from './types.ts';

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
