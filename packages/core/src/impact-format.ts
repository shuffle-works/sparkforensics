// Savings figures as every surface prints them: the dashboard's widgets and verdict, and the
// CLI/MCP evidence report. One formatter set, so units and rounding never drift between paths.
import { fmtMs, formatRawWaste, formatWallClockRange, readsAsZero } from './format-utils.ts';
import type { Finding, ImpactEstimate, RawWasteFigure } from './types.ts';

/** A finding's one-line savings figure: the wall-clock range for a time-based
 * finding, the raw resource figure for a `resourceOnly` one, or nothing for a
 * purely informational estimate or a raw figure that rounds to zero ("0.0
 * core-h" reads as a measured nothing). */
export function impactFigure(finding: Finding): string | null {
  const estimate = finding.impactEstimate;
  if (!estimate) return null;
  if (estimate.wallClock) return formatWallClockRange(estimate.wallClock.low, estimate.wallClock.high);
  if (estimate.rawWaste) {
    const text = formatRawWaste(estimate.rawWaste);
    return readsAsZero(text) ? null : text;
  }
  return null;
}

/** What a raw-waste figure counts, by its unit, as the words that follow it. */
export function rawWasteMeaning(unit: RawWasteFigure['unit'] | undefined): string | null {
  switch (unit) {
    case 'mbSeconds': return 'of unused executor memory';
    case 'coreHours':
    case 'coreMs': return 'of core time';
    case 'bytes': return 'of extra data written';
    case 'ms': return 'of task time';
    default: return null;
  }
}

/** What a savings figure counts, as the words that follow it: run time for a
 * wall-clock claim, or the resource a cost-only (`resourceOnly`) figure
 * measures. A time figure and a capacity figure look alike ("58.6s",
 * "0.7 core-h") but only the first shortens the run. Null when the finding
 * shows no figure. */
export function savingsMeaning(finding: Finding): string | null {
  const estimate = finding.impactEstimate;
  if (!estimate) return null;
  if (estimate.wallClock) return 'of run time';
  return rawWasteMeaning(estimate.rawWaste?.unit);
}

/** A finding's "Potential savings" figure as the widget board shows it: the
 * wall-clock range, or the raw waste only when there is no wall-clock claim,
 * never both (they would read as two competing numbers). A zero-value
 * estimate is suppressed like an informational one: "0s" reads as a measured
 * figure. `meaning` says what the shown figure counts. */
export function impactEstimateFigure(estimate: ImpactEstimate | undefined): { text: string; meaning: string | null } | null {
  if (!estimate) return null;
  const highText = estimate.wallClock && estimate.wallClock.high > 0 ? fmtMs(estimate.wallClock.high) : null;
  if (highText && !readsAsZero(highText)) {
    return { text: formatWallClockRange(estimate.wallClock!.low, estimate.wallClock!.high), meaning: 'of run time' };
  }
  const rawWasteText = estimate.rawWaste && estimate.rawWaste.value > 0 ? formatRawWaste(estimate.rawWaste) : null;
  if (rawWasteText && !readsAsZero(rawWasteText)) return { text: rawWasteText, meaning: rawWasteMeaning(estimate.rawWaste!.unit) };
  return null;
}

/** Compact single-value form for dense lists (the stage table's finding chips,
 * the stage dialog): the high-end wall-clock figure, or the raw-waste figure
 * when there's no wall-clock claim, or `null` for a purely informational or a
 * zero-value estimate (a `0s` in the spot a real estimate goes would read as a
 * measured nothing). */
export function impactEstimateCompact(estimate: ImpactEstimate | undefined): string | null {
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

/** How a step's savings figure was derived, in one plain sentence for
 * Advanced view: the estimate method, whether the stage ran alone (a
 * near-point figure) or shared the cluster (a floor and an optimistic high),
 * and the raw waste behind it. Null when the finding carries no estimate
 * model (`estimateMethod: 'none'`), no estimate at all, or a figure that
 * reads as zero (the step shows no savings then either). Uses the same
 * formatting and zero rules as the step's own savings figure. */
export function estimateProvenance(finding: Pick<Finding, 'impactEstimate'>): string | null {
  const estimate = finding.impactEstimate;
  if (!estimate || estimate.estimateMethod === 'none') return null;
  const method = estimate.estimateMethod;
  const rawWaste = estimate.rawWaste && estimate.rawWaste.value > 0 ? estimate.rawWaste : null;
  const raw = rawWaste && !readsAsZero(formatRawWaste(rawWaste)) ? formatRawWaste(rawWaste) : null;
  const wallClock = estimate.wallClock;
  if (estimate.basis === 'resourceOnly') {
    return raw ? `No run-time claim, ${method}. ${raw} was wasted, but it may not shorten the run.` : null;
  }
  if (!wallClock || wallClock.high <= 0) return null;
  const highText = formatWallClockRange(wallClock.high, wallClock.high);
  if (readsAsZero(highText)) return null;
  let rawNote = '';
  if (raw && rawWaste!.unit !== 'ms') rawNote = ` Resource waste measured: ${raw}.`;
  else if (raw && rawWaste!.value > wallClock.high && raw !== highText) rawNote = ` Raw waste before the floor clipped it: ${raw}.`;
  if (estimate.basis === 'serial') {
    return `${highText}, ${method}. The stage ran effectively alone, so this is close to a point estimate.${rawNote}`;
  }
  if (estimate.basis === 'contended') {
    const lowText = formatWallClockRange(wallClock.low, wallClock.low);
    const range = formatWallClockRange(wallClock.low, wallClock.high);
    const spread = lowText === highText ? 'its floor and optimistic high agree' : `${lowText} is the floor, ${highText} assumes the fix fully lands`;
    return `${range}, ${method}. The stage shared the cluster with others: ${spread}.${rawNote}`;
  }
  return null;
}
