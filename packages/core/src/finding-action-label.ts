import { findingName } from './finding-names.ts';
import { presentationOf } from './finding-presentation.ts';
import type { Finding } from './types.ts';

/** A short, imperative action label for a finding's row ("Reduce shuffle size"), from its type's
 * FINDING_PRESENTATION row. A (type, discriminant) combination the row doesn't recognize falls
 * back to the type's name, and an unknown type to its raw string. The dashboard, the run verdict
 * and the evidence report all call this one function, so a finding shows the same label on every
 * path. */
export function findingActionLabel(finding: Finding): string {
  return presentationOf(finding.type)?.actionLabel(finding) ?? findingName(finding.type);
}
