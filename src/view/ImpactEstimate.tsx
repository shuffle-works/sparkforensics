import { useId } from 'react';
import type { Finding, ImpactEstimate as ImpactEstimateType, RawWasteFigure } from '@sparkforensics/core/types.ts';
import { formatDuration, formatBytes } from '@sparkforensics/core/format-utils.ts';

function fmtMs(ms: number): string {
  return ms === 0 ? '0s' : formatDuration(ms);
}

export function formatWallClockRange(low: number, high: number): string {
  const lowText = fmtMs(low);
  const highText = fmtMs(high);
  // Compare the formatted strings, not the raw ms values: formatDuration
  // floors to whole seconds (or minutes+seconds) once a value hits 60s, so
  // two endpoints that differ by under a bucket's precision (e.g. 140900ms
  // vs 141200ms, both "2m 21s") would still fail a raw low === high check
  // and render as a degenerate "2m 21s-2m 21s" range.
  if (lowText === highText) return highText;
  return `${lowText}-${highText}`;
}

export function formatRawWaste(rawWaste: RawWasteFigure): string {
  const rounded = Math.round(rawWaste.value * 10) / 10;
  switch (rawWaste.unit) {
    case 'bytes':
      return formatBytes(rawWaste.value);
    case 'ms':
      return fmtMs(rawWaste.value);
    case 'mbSeconds':
      return `${rounded.toLocaleString('en-US')} MB-s`;
    case 'coreHours':
      return `${rounded.toFixed(1)} core-h`;
    case 'coreMs':
      return `${rounded.toLocaleString('en-US')} core-ms`;
    default:
      return String(rawWaste.value);
  }
}

// formatRawWaste/fmtMs round to a fixed precision (one decimal place, or
// whole milliseconds below 1s), which can collapse a small but genuinely
// nonzero value down to a formatted string that reads exactly like zero
// (0.04 coreHours -> "0.0 core-h"). Checking the raw value against 0 misses
// this; checking the *formatted* text against zero's own formatted text
// catches it regardless of unit. The fractional group must consume the
// entire decimal part (all zeros) before the terminator: otherwise a real
// value like "0.5 core-h" leaves the "." unconsumed, and the terminator
// char class excludes ".", so it correctly fails to match.
export function readsAsZero(formatted: string): boolean {
  return /^0(\.0+)?(?:[^0-9.]|$)/.test(formatted);
}

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
  const highText = estimate.wallClock && estimate.wallClock.high > 0 ? fmtMs(estimate.wallClock.high) : null;
  const rangeText =
    highText && !readsAsZero(highText) ? formatWallClockRange(estimate.wallClock!.low, estimate.wallClock!.high) : null;
  const rawWasteText = estimate.rawWaste && estimate.rawWaste.value > 0 ? formatRawWaste(estimate.rawWaste) : null;
  const wasteText = !rangeText && rawWasteText && !readsAsZero(rawWasteText) ? rawWasteText : null;
  const valueText = rangeText ?? wasteText;
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
