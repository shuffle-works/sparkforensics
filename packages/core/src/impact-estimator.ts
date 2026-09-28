import type { Finding } from './types.ts';
import { DETECTORS, type Detector } from './detectors.ts';
import type { EstimateCtx } from './impact-model.ts';

export type { EstimateCtx } from './impact-model.ts';

// The entry whose estimate() prices each finding type. Several entries can emit one type (the four
// configAudit audits), all with the same estimate; the first declared wins.
const ENTRY_BY_TYPE = new Map<string, Detector>();
for (const entry of DETECTORS as readonly Detector[]) {
  for (const type of entry.emits) if (!ENTRY_BY_TYPE.has(type)) ENTRY_BY_TYPE.set(type, entry);
}

/** Attaches each finding's `impactEstimate` from its entry's estimate(), in place. A null estimate
 * leaves the finding uncovered (no impactEstimate). `ctx` is analyze()'s one occupancy sweep. */
export function estimateImpact(findings: Finding[], ctx: EstimateCtx): Finding[] {
  for (const f of findings) {
    const estimate = ENTRY_BY_TYPE.get(f.type)?.estimate(f, ctx);
    if (estimate) f.impactEstimate = estimate;
  }
  return findings;
}
