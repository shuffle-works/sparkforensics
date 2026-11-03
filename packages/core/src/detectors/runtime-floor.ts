import { appDurationMs } from '../impact-band.ts';
import type { DetectorCtx, DetectorStage } from './types.ts';

// Absolute-magnitude floor as a % of app runtime, not a fixed ms constant: a skew/straggler
// ratio on a few ms is noise in an hours-long run but real in a seconds-long one; a fixed-ms
// floor can't scale. Used by skew/straggler, gated on the same occupancy-clipped tail claim their
// estimate() displays as savings (tailClaimImpact).
// Unknown app timing never suppresses a finding; it just skips the floor gate.
export function meetsRuntimeFloor(wasteMs: number, runMs: number | null, floorPct: number): boolean {
  return runMs == null || wasteMs >= runMs * floorPct;
}

// A stage that ran for less than floorPct of the run (a known duration): an estimate clipped to
// the stage can't reach floorPct, so every finding there grades info. A zero-length stage (no
// submission time on older Spark) is not skipped: it gets no estimate and keeps its own band.
export function stageBelowRuntimeFloor(stage: DetectorStage, ctx: DetectorCtx, floorPct: number): boolean {
  const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  const runMs = appDurationMs(ctx.app);
  return runMs != null && stageDurationMs > 0 && stageDurationMs < runMs * floorPct;
}
