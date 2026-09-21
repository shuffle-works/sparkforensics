import type { EvidenceKey } from '@sparkforensics/core/types.ts';
import { useAccessibleTooltip } from '@/view/AccessibleTooltip';
import { evidenceLabel, useEvidenceAvailabilityNavigation } from '@/view/EvidenceAvailabilityContext';

export interface RowStatusClusterProps {
  confidence?: string;
  validationRequired?: string;
  evidenceKey?: EvidenceKey;
}

/** Fixed-position, always-visible replacement for the old per-row
 * ConfidenceMarker/EvidenceLink/ExpandToggleButton trio: one cluster that
 * shows confidence and/or evidence with no click needed to reveal either.
 * Confidence is plain, non-interactive text with a tooltip carrying the full
 * `validationRequired` detail; evidence is the cluster's one real click
 * target, wired to the same `revealEvidence` navigation `EvidenceLink` used.
 * Renders nothing when there's nothing to show, so callers never need a
 * guard around the JSX. */
export function RowStatusCluster({ confidence, validationRequired, evidenceKey }: RowStatusClusterProps) {
  // Called unconditionally, before any early return, per rules of hooks.
  const { tooltipProps, srOnlyTooltip } = useAccessibleTooltip(validationRequired);
  const { revealEvidence } = useEvidenceAvailabilityNavigation();

  const hasConfidence = Boolean(confidence) && confidence !== 'high';
  const hasEvidence = Boolean(evidenceKey);

  if (!hasConfidence && !hasEvidence) return null;

  return (
    <span
      className="relative inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-muted/60 px-2.5 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      // Focusable only when it actually carries a tooltip to reveal: native
      // `title` never fires on keyboard focus, so without this tab stop a
      // sighted keyboard-only user could never reach the confidence caveat
      // (a screen reader already gets it via the sr-only/aria-describedby
      // pair in useAccessibleTooltip, independent of focus).
      tabIndex={hasConfidence ? 0 : undefined}
      {...(hasConfidence ? tooltipProps : {})}
    >
      {hasConfidence ? (
        <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-full border border-dashed border-current" />
      ) : null}
      {hasConfidence ? `${confidence} confidence` : null}
      {hasConfidence ? srOnlyTooltip : null}
      {hasConfidence && hasEvidence ? <span aria-hidden="true" className="opacity-60">&middot;</span> : null}
      {hasEvidence ? (
        <button
          type="button"
          aria-label={`Evidence: ${evidenceLabel(evidenceKey as EvidenceKey)}`}
          // `tap-target-comfortable--sm`'s overlay is calibrated for a ~22px
          // control (see WidgetCard's disclosure trigger); this button's
          // text-xs content alone only measures ~16px tall, 6px short of the
          // 44px effective touch target that calibration assumes. `min-h`
          // brings the control itself up to the 22px the overlay expects.
          className="tap-target-comfortable tap-target-comfortable--sm inline-flex min-h-[22px] cursor-pointer items-center rounded-sm text-primary outline-none hover:underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => revealEvidence(evidenceKey as EvidenceKey)}
        >
          {evidenceLabel(evidenceKey as EvidenceKey)}
        </button>
      ) : null}
    </span>
  );
}
