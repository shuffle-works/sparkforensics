import { useId } from 'react';
import type { Finding, ImpactEstimate as ImpactEstimateType } from '@sparkforensics/core/types.ts';
import {
  fmtMs, formatRawWaste, formatWallClockRange, impactEstimateFigure, readsAsZero,
} from '@sparkforensics/core/impact-format.ts';

export { formatRawWaste, formatWallClockRange, readsAsZero };

/** Compact single-value form for dense lists (StageTable's finding chips,
 * StageDetailDialog's StageVerdict): the high-end wall-clock figure, or the
 * raw-waste figure when there's no wall-clock claim, or `null` for a purely
 * informational estimate, or a zero-value one (`wallClock.high`/`rawWaste.value`
 * of exactly 0 reads as a real number in the same spot a genuine estimate
 * would, misleadingly implying the detector measured a real recoverable
 * amount rather than none). The full `<ImpactEstimate>` component below is
 * for the widget board, where there's room for a full range. */
export function formatImpactEstimateCompact(estimate: ImpactEstimateType | undefined): string | null {
  if (!estimate) return null;
  if (estimate.wallClock) {
    if (estimate.wallClock.high <= 0) return null;
    const text = fmtMs(estimate.wallClock.high);
    return readsAsZero(text) ? null : text;
  }
  if (estimate.rawWaste) {
    if (estimate.rawWaste.value <= 0) return null;
    const text = formatRawWaste(estimate.rawWaste);
    return readsAsZero(text) ? null : text;
  }
  return null;
}

export function ImpactEstimate({ finding }: { finding: Finding }) {
  const estimateMethodId = useId();
  const estimate = finding.impactEstimate;
  if (!estimate) return null;

  // The range is the recoverable-time claim; rawWaste (the pre-clip figure)
  // is only shown as a fallback when there's no wall-clock range at all
  // (basis: 'resourceOnly', e.g. idle-core-ms, spill bytes), never
  // alongside the range, which would read as two competing numbers for one
  // finding. A zero-value estimate (high === 0, or a zero rawWaste) is
  // suppressed the same as the 'informational' basis below: "Potential
  // savings: 0s" reads as a real, measured figure in the exact spot a real
  // one would go, not as "there's nothing to recover here."
  const valueText = impactEstimateFigure(estimate)?.text;
  if (!valueText) return null; // basis: 'informational', or a zero-value estimate

  const title = `Estimate method: ${estimate.estimateMethod}`;

  // A plain labeled stat line, matching the "Label: <strong>value</strong>"
  // convention every widget already uses for its own figures (GcPressure's
  // "GC: X% · Executor run time: Y", Spill's "Memory spilled: X · Disk: Y"):
  // no badge, no color, so the estimate reads as one more fact among peers
  // instead of competing chip-noise on an already-dense board.
  return (
    <span
      className="impact-estimate text-xs text-muted-foreground"
      title={title}
      tabIndex={0}
      aria-describedby={estimateMethodId}
    >
      Potential savings: <strong>{valueText}</strong>
      <span id={estimateMethodId} className="sr-only">
        {title}
      </span>
    </span>
  );
}
