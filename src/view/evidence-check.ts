import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

/** What a widget's row needs to decide whether it has anything to show. */
export interface RowContext {
  advanced: boolean;
  appModel: AppModel;
}

/** True when a widget's row for `finding` renders something. `stated` is true when the line above
 * the evidence panel already states the finding. A widget's row returns nothing exactly when its
 * own version of this is false, and its evidence check is built from the same function, so the
 * two cannot disagree. */
export type RowShows = (finding: Finding, stated: boolean, context: RowContext) => boolean;

export interface EvidenceCheckInput extends RowContext {
  /** The findings the evidence panel is for. */
  findings: readonly Finding[];
  /** Ids of the findings the line above the panel states. */
  stated: ReadonlySet<string>;
}

/** Whether a widget has anything to show for `findings` beyond what the line above states. The
 * host offers the evidence control and renders the panel only when this is true. */
export type EvidenceCheck = (input: EvidenceCheckInput) => boolean;

export function evidenceCheck(rowShows: RowShows): EvidenceCheck {
  return ({ findings, stated, ...context }) => findings.some((finding) => rowShows(finding, finding.id != null && stated.has(finding.id), context));
}

/** Whether a row that is only the figure the line above states renders: nothing is left once it
 * is stated. */
export function unstatedRowShows(stated: boolean): boolean {
  return !stated;
}

/** The check of a widget whose rows are only what the line above states. */
export const UNSTATED_EVIDENCE: EvidenceCheck = evidenceCheck((_finding, stated) => unstatedRowShows(stated));
