import type { Finding } from '@sparkforensics/core/types.ts';
import { formatRawWaste, formatWallClockRange, readsAsZero } from '@sparkforensics/core/impact-format.ts';

// The verdict's ranking, grouping and wording live in core (shared with the CLI/MCP report);
// re-exported here for the view modules and tests that already import them from this path.
export { savingsMeaning } from '@sparkforensics/core/impact-format.ts';
export {
  buildNextSteps, IDLE_NOTABLE_PCT, isIdleCapacityStep, locationKey, NEXT_STEP_LIMIT, verdictIdlePct, type NextStep,
} from '@sparkforensics/core/run-verdict.ts';

/** How a step's savings figure was derived, in one plain sentence for
 * Advanced view: the estimate method, whether the stage ran alone (a
 * near-point figure) or shared the cluster (a floor and an optimistic high),
 * and the raw waste behind it. Null when the finding carries no estimate
 * model (`estimateMethod: 'none'`), no estimate at all, or a figure that
 * reads as zero (the step shows no savings then either). Uses the same
 * formatting and zero rules as the step's own savings figure. */
export function estimateProvenance(finding: Finding): string | null {
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
