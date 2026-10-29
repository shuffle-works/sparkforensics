import { useId } from 'react';
import type { Finding } from '@sparkforensics/core/types.ts';
import { useFindingSavings } from '@/view/interpretation';

export function ImpactEstimate({ finding }: { finding: Finding }) {
  const estimateMethodId = useId();
  const savings = useFindingSavings(finding);
  const estimate = finding.impactEstimate;
  if (!estimate) return null;

  // The range is the recoverable-time claim; rawWaste (the pre-clip figure)
  // is only shown as a fallback when there's no wall-clock range at all
  // (basis: 'resourceOnly', e.g. idle-core-ms, spill bytes), never
  // alongside the range, which would read as two competing numbers for one
  // finding. A zero-value estimate (high === 0, or a zero rawWaste) is
  // suppressed the same as the 'informational' basis below: "Potential
  // savings: 0s" reads as a real, measured figure in the exact spot a real
  // one would go, not as "there's nothing to recover here." The run's
  // interpretation already applied those rules (`FindingSavings.board`).
  const valueText = savings?.board;
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
