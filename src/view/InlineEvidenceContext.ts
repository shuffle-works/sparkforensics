import { createContext, useContext } from 'react';

import type { Finding, ImpactBand } from '@sparkforensics/core/types.ts';

/** What a finding's in-place evidence panel knows about the line above it. */
export interface InlineEvidenceState {
  /** Ids of the findings the line above already states (stage, savings, and
   * the measured figures in its sentence). A finding the line does not state
   * keeps all of its own facts. */
  stated: ReadonlySet<string>;
  /** The impact band of the finding the line above states, for the panel's
   * left rule; absent for a group row, where the widget's own band applies. */
  band?: ImpactBand;
}

export const InlineEvidenceContext = createContext<InlineEvidenceState | null>(null);

/** The panel's state, or null outside an in-place evidence panel (the grid, the
 * Full app report, the stage dialog), where widgets render in full. */
export function useInlineEvidence(): InlineEvidenceState | null {
  return useContext(InlineEvidenceContext);
}

/** True when the line above the evidence panel already states this finding, so
 * the panel leaves out the stage chip, the savings figure and any figure that
 * line repeats. Always false outside an evidence panel. */
export function useStatedAbove(finding: Finding): boolean {
  const state = useInlineEvidence();
  return finding.id != null && (state?.stated.has(finding.id) ?? false);
}

/** `useStatedAbove` for a stage's findings: true when the line above states any of them. */
export function useAnyStatedAbove(findings: readonly Finding[]): boolean {
  const state = useInlineEvidence();
  return findings.some((finding) => finding.id != null && (state?.stated.has(finding.id) ?? false));
}
