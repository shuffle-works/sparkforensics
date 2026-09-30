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
  return findings;
}
