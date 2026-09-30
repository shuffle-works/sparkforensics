import type { Finding } from './types.ts';
import { ENTRY_BY_TYPE } from './detectors.ts';
import { coreTimeFor, type EstimateCtx } from './impact-model.ts';

export type { EstimateCtx } from './impact-model.ts';

/** Attaches each finding's `impactEstimate` from its entry's estimate(), in place. A null estimate
 * leaves the finding uncovered (no impactEstimate). `ctx` is analyze()'s one occupancy sweep. */
export function estimateImpact(findings: Finding[], ctx: EstimateCtx): Finding[] {
  for (const f of findings) {
    const estimate = ENTRY_BY_TYPE.get(f.type)?.estimate(f, ctx);
    if (estimate) f.impactEstimate = { ...estimate, coreTimeMs: coreTimeFor(f, estimate, ctx) };
  }
  countTailCoreTimeOnce(findings);
  return findings;
}

// skew, straggler and stageSlowness each claim the same slow tail of a stage, so each reports
// its removed task time: summed over a stage's findings that would count the tail up to three
// times. The first of them in this order keeps the figure; the others carry null, since
// their tail is already counted there.
const TAIL_CORE_TIME_ORDER = ['skew', 'straggler', 'stageSlowness'];

function countTailCoreTimeOnce(findings: Finding[]): void {
  const counted = new Set<number>();
  const tails = findings
    .filter((f) => f.stageId != null && f.impactEstimate?.coreTimeMs != null && TAIL_CORE_TIME_ORDER.includes(f.type))
    .sort((a, b) => TAIL_CORE_TIME_ORDER.indexOf(a.type) - TAIL_CORE_TIME_ORDER.indexOf(b.type));
  for (const f of tails) {
    if (counted.has(f.stageId as number)) f.impactEstimate!.coreTimeMs = null;
    else counted.add(f.stageId as number);
  }
}
