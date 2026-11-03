import { tailRecoveryMs, tailRemovedWorkMs, stragglerFixLongestTaskMs, type TailStage } from '../occupancy.ts';
import { appDurationMs } from '../impact-band.ts';
import { TAIL_CLAIM, singleStageImpact, type EstimateCtx } from '../impact-model.ts';
import type { ImpactEstimate, TailAttribution } from '../types.ts';
import type { TailCause } from '../finding-types.ts';
import { meetsRuntimeFloor } from './runtime-floor.ts';
import type { DetectorCtx, DetectorStage } from './types.ts';

// True task-duration skew ratio: P95/median once enough tasks to trust P95, else max/median.
// Null when the median is not a positive number or the numerator is not finite (a stage with no
// task records). Exported so cli/budgets.ts recomputes the same ratio rather than reading findings
// floored at ratioWarn.
// Fields optional: budgets.ts calls this against raw AppModel.stages, whose stages may lack
// these fields (unfinished run).
export function computeSkewRatio(
  stage: { taskCount?: number; taskDurationP50?: number; taskDurationP95?: number; taskDurationMax?: number },
  minTasksForP95: number,
): { ratio: number; metric: 'P95/median' | 'max/median' } | null {
  const { taskCount, taskDurationP50: p50, taskDurationP95: p95, taskDurationMax: max } = stage;
  if (typeof p50 !== 'number' || !(p50 > 0)) return null;
  const usesP95 = (taskCount ?? 0) >= minTasksForP95;
  const numerator = usesP95 ? p95 : max;
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  return { ratio: numerator / p50, metric: usesP95 ? 'P95/median' : 'max/median' };
}

// What a skew or straggler fix claims off its stage: the wall-clock its slow tail costs, the task
// time the fix removes, and the longest task it leaves. One figure, read twice: detect() gates its
// runtime floor on the claim's clipped estimate and estimate() reports that same estimate as the
// savings, so the firing floor and the displayed figure can't disagree.
interface TailClaim {
  wasteMs: number;
  removedCoreWorkMs: number;
  longestTaskAfterFixMs: number;
}

// singleDelta: the slowest task's own excess, the fallback when the stage has no task replay.
function tailClaim(stage: TailStage, singleDelta: number, longestTaskAfterFixMs: number): TailClaim {
  return {
    wasteMs: tailRecoveryMs(stage, singleDelta),
    removedCoreWorkMs: tailRemovedWorkMs(stage, singleDelta),
    longestTaskAfterFixMs,
  };
}

// skew's delta is the task computeSkewRatio's metric sampled (P95 or max) over the median. Fixing
// the skew still waits on the longest task it leaves, as for straggler.
export function skewTailClaim(stage: TailStage & { taskDurationP95?: number }, usesP95Branch: boolean): TailClaim {
  const p50 = stage.taskDurationP50 ?? 0;
  const singleDelta = Math.max(0, usesP95Branch ? (stage.taskDurationP95 ?? 0) - p50 : (stage.taskDurationMax ?? 0) - p50);
  return tailClaim(stage, singleDelta, stragglerFixLongestTaskMs(stage));
}

// straggler's delta is the slowest task over the longest one the fix leaves.
export function stragglerTailClaim(stage: TailStage): TailClaim {
  const longestTaskAfterFixMs = stragglerFixLongestTaskMs(stage);
  return tailClaim(stage, Math.max(0, (stage.taskDurationMax ?? 0) - longestTaskAfterFixMs), longestTaskAfterFixMs);
}

// A tail claim shortens the stage's longest task, hence TAIL_CLAIM (see occupancy.ts). Its core
// time is the measured task time the fix removes (removedCoreWorkMs).
export function tailClaimImpact(claim: TailClaim, stageId: number, ctx: EstimateCtx): ImpactEstimate {
  const estimate = singleStageImpact(claim.wasteMs, stageId, ctx, 'measured', { value: claim.wasteMs, unit: 'ms' },
    { ...TAIL_CLAIM, removedCoreWorkMs: claim.removedCoreWorkMs, longestTaskAfterFixMs: claim.longestTaskAfterFixMs });
  return { ...estimate, coreTimeMs: { low: claim.removedCoreWorkMs, high: claim.removedCoreWorkMs } };
}

// The figure a runtime floor checks: the claim's recoverable wall-clock, not a delta a physical
// floor leaves unrecoverable. Falls back to the raw claim when occupancy data is unavailable.
export function tailClaimFloorMs(claim: TailClaim, stageId: number, ctx: DetectorCtx): number {
  return tailClaimImpact(claim, stageId, ctx.impact).wallClock?.high ?? claim.wasteMs;
}

// skew's duration gate: the task-time ratio over `ratioWarn` whose occupancy-clipped tail claim
// (the claim estimate() reports as savings, so the gate agrees with it) is at least `floorPctWarn`
// of the run. Null when it does not hold. straggler runs it too, to report the tails skew's gate
// admits whose cause is not data.
export function skewGate(
  stage: DetectorStage, ctx: DetectorCtx, ratioWarn: number, minTasksForP95: number, floorPctWarn: number,
): { ratio: number; metric: 'P95/median' | 'max/median' } | null {
  const result = computeSkewRatio(stage, minTasksForP95);
  if (result === null || result.ratio <= ratioWarn) return null;
  const floorWasteMs = tailClaimFloorMs(skewTailClaim(stage, result.metric === 'P95/median'), stage.id, ctx);
  return meetsRuntimeFloor(floorWasteMs, appDurationMs(ctx.app), floorPctWarn) ? result : null;
}

// Why a stage's slow tail is slow, from attributeTail (stage-quantiles.ts). 'data' when data volume
// accounts for at least `dataShareMin` of the tail's extra time, else the largest of GC, fetch wait,
// one host and 'unexplained'. 'unattributed' (no data volume to compare, or no tail attribution)
// means only the duration is known, so straggler reports it and skew does not.
export interface TailVerdict {
  cause: TailCause;
  // Share (0-100) of the tail's extra time the cause accounts for; 0 for 'unattributed'.
  sharePct: number;
  attribution: TailAttribution | null;
}

export function tailVerdict(stage: Pick<DetectorStage, 'tailAttribution'>, dataShareMin: number): TailVerdict {
  const a = stage.tailAttribution ?? null;
  if (a === null || !(a.excessMs > 0)) return { cause: 'unattributed', sharePct: 0, attribution: a };
  const pct = (ms: number) => Math.round((ms / a.excessMs) * 100);
  if (a.dataMs / a.excessMs >= dataShareMin) return { cause: 'data', sharePct: pct(a.dataMs), attribution: a };
  const rest = Math.max(0, a.excessMs - a.dataMs - a.gcMs - a.fetchWaitMs - a.hostMs);
  const causes: [TailCause, number][] = [['gc', a.gcMs], ['fetchWait', a.fetchWaitMs], ['host', a.hostMs],
    [a.dataRatio === null ? 'unattributed' : 'unexplained', rest]];
  const [cause, ms] = causes.reduce((best, c) => (c[1] > best[1] ? c : best));
  return { cause, sharePct: cause === 'unattributed' ? 0 : pct(ms), attribution: a };
}
