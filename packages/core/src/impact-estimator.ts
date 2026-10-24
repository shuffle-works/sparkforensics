import type { Finding } from './types.ts';
import { ENTRY_BY_TYPE } from './detectors.ts';
import { coreTimeFor, stageTaskMs, type EstimateCtx } from './impact-model.ts';

export type { EstimateCtx } from './impact-model.ts';

// The task time of the stages the finding sits on; undefined when there is none.
function findingStageTaskMs(f: Finding, ctx: EstimateCtx): number | undefined {
  const ids = 'stageIds' in f ? f.stageIds : f.stageId != null ? [f.stageId] : [];
  const total = ids.reduce((sum, id) => sum + (ctx.stages.has(id) ? stageTaskMs(ctx.stages.get(id)!) : 0), 0);
  return total > 0 ? total : undefined;
}

/** Attaches each finding's `impactEstimate` from its entry's estimate(), in place. A null estimate
 * leaves the finding uncovered (no impactEstimate). `ctx` is analyze()'s one occupancy sweep. */
export function estimateImpact(findings: Finding[], ctx: EstimateCtx): Finding[] {
  for (const f of findings) {
    const estimate = ENTRY_BY_TYPE.get(f.type)?.estimate(f, ctx);
    if (!estimate) continue;
    f.impactEstimate = { ...estimate, coreTimeMs: coreTimeFor(f, estimate), stageTaskMs: findingStageTaskMs(f, ctx) };
  }
  countTailCoreTimeOnce(findings);
  return findings;
}

// skew and straggler claim the same slow tail of a stage, so each reports its removed task time:
// summed over a stage's findings that would count the tail twice. skew keeps the figure; a
// straggler on the same stage carries null, since its tail is already counted there.
const TAIL_CORE_TIME_ORDER = ['skew', 'straggler'];

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
