import { createContext, useContext } from 'react';

import type { ImpactBand } from '@sparkforensics/core/types.ts';

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
