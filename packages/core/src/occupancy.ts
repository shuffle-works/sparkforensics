// Occupancy-weighted wall-clock attribution for per-finding impact: every
// stage's wall-clock claim is apportioned purely from its own observed window
// and how much it overlapped with other stages. No graph, no parentIds traversal.
import { mergeIntervals } from './wall-clock.ts';

export interface OccupancyStage {
  id: number;
  submittedAt?: number;
  completedAt?: number;
  executorRunTime?: number;
  taskDurationMax?: number;
}

function durationMs(s: OccupancyStage): number {
  return (s.completedAt ?? 0) - (s.submittedAt ?? 0);
}

// Average-concurrency proxy, held constant across the stage's active window:
// no per-task timestamps exist outside the parser worker to do better.
function coreWeight(s: OccupancyStage): number {
  const d = durationMs(s);
  return d > 0 ? (s.executorRunTime ?? 0) / d : 0;
}

/**
 * Sweeps every stage's observed [submittedAt, completedAt) window and splits
 * each instant's wall-clock among the stages active at that instant,
 * proportional to coreWeight(S). Stages with duration(S) <= 0 are excluded
 * entirely: they get no key in the returned map. When every active stage in
 * an interval has coreWeight 0 (no executorRunTime data), the interval is
 * split equally among them instead of everyone getting 0: a lone active
 * stage must still resolve to occupying its own whole window regardless of
 * whether core-time data exists for it.
 */
export function computeOccupancyMs(stages: Map<number, OccupancyStage>): Map<number, number> {
  const valid = [...stages.values()].filter((s) => durationMs(s) > 0);
  const occupancy = new Map<number, number>();
  for (const s of valid) occupancy.set(s.id, 0);
  if (valid.length === 0) return occupancy;

  const events: { time: number; id: number; weight: number; isStart: boolean }[] = [];
  for (const s of valid) {
    const w = coreWeight(s);
    events.push({ time: s.submittedAt ?? 0, id: s.id, weight: w, isStart: true });
    events.push({ time: s.completedAt ?? 0, id: s.id, weight: w, isStart: false });
  }
  events.sort((a, b) => a.time - b.time);

  const active = new Map<number, number>(); // id -> coreWeight
  let prevTime = events[0].time;
  let i = 0;
  while (i < events.length) {
    const time = events[i].time;
    if (time > prevTime && active.size > 0) {
      const span = time - prevTime;
      let totalWeight = 0;
      for (const w of active.values()) totalWeight += w;
      for (const [id, w] of active) {
        const share = totalWeight > 0 ? w / totalWeight : 1 / active.size;
        occupancy.set(id, (occupancy.get(id) ?? 0) + span * share);
      }
    }
    while (i < events.length && events[i].time === time) {
      const e = events[i];
      if (e.isStart) active.set(e.id, e.weight);
      else active.delete(e.id);
      i++;
    }
    prevTime = time;
  }
  return occupancy;
}

/**
 * Occupancy-share of a stage's own observed duration, gate(S) in [0, 1];
 * 1.0 means the stage ran completely alone, 0 means it had zero executorRunTime
 * while overlapping other, positive-weight stages (so it got no share of the
 * shared window). Excludes stages with duration(S) <= 0 (no key in the result).
 */
export function computeGate(stages: Map<number, OccupancyStage>): Map<number, number> {
  const occupancyMs = computeOccupancyMs(stages);
  const gate = new Map<number, number>();
  for (const s of stages.values()) {
    const d = durationMs(s);
    if (d <= 0) continue;
    const occ = occupancyMs.get(s.id) ?? 0;
    // Clamp for float round-off in the sweep; occupancy can never truly exceed duration.
    gate.set(s.id, Math.min(1, occ / d));
  }
  return gate;
}

/**
 * A physical floor on a stage's own duration: bounded below by its single
 * longest task (unsplittable no matter how much parallelism exists) or by
 * its total core-work spread across every core in the cluster, whichever is
 * larger. totalCores <= 0 (no executor data) falls back to taskDurationMax
 * alone.
 */
export function computeCeiling(stage: OccupancyStage, totalCores: number): number {
  const taskDurationMax = stage.taskDurationMax ?? 0;
  if (totalCores <= 0) return taskDurationMax;
  const coreWork = stage.executorRunTime ?? 0;
  return Math.max(taskDurationMax, coreWork / totalCores);
}

/**
 * Caps a waste formula's raw claim at the portion of the stage's own
 * observed duration that sits above its physical floor: a finding can never
 * claim to recover more than that.
 */
export function clipToCeiling(wasteMsClaimed: number, stage: OccupancyStage, ceiling: number): number {
  const room = Math.max(0, durationMs(stage) - ceiling);
  return Math.min(wasteMsClaimed, room);
}

export interface StageOccupancyInfo {
  gate: number;
  ceiling: number;
  // The core-work half of `ceiling` (executorRunTime / totalCores, 0 without core data): the only
  // floor left for a claim that itself shortens the stage's longest task.
  coreWorkFloor: number;
}

export function computeOccupancy(
  stages: Map<number, OccupancyStage>,
  totalCores: number,
): Map<number, StageOccupancyInfo> {
  const gate = computeGate(stages);
  const info = new Map<number, StageOccupancyInfo>();
  for (const s of stages.values()) {
    const g = gate.get(s.id);
    if (g === undefined) continue; // excluded from the sweep (duration <= 0)
    info.set(s.id, {
      gate: g,
      ceiling: computeCeiling(s, totalCores),
      coreWorkFloor: totalCores > 0 ? (s.executorRunTime ?? 0) / totalCores : 0,
    });
  }
  return info;
}

const SERIAL_GATE_THRESHOLD = 0.999;

export interface OccupancyEstimate {
  basis: 'serial' | 'contended';
  wallClock: { low: number; high: number };
}

export interface TailStage {
  stragglerExcessMs?: number;
  peakConcurrentTasks?: number;
  stragglerCount?: number;
  longestNonStragglerMs?: number;
  tailReplayRecoveryMs?: number;
  taskDurationP50?: number;
  taskDurationMax?: number;
}

// Wall-clock a skew/straggler fix recovers: finalizeStage's task-level replay
// (tailReplayRecoveryMs, computeTailReplayRecoveryMs) when the stage carries it. Without it (a
// stage built by hand, as in detector tests) an estimate from the slowest task's excess over the
// median: a lone straggler costs that excess; a tail of many slow tasks costs its summed excess
// (stragglerExcessMs) spread over the slots the stage had (peakConcurrentTasks), and the replay
// recovers about the larger of the two.
export function tailRecoveryMs(stage: TailStage, singleTaskExcessMs: number): number {
  if (stage.tailReplayRecoveryMs != null) return stage.tailReplayRecoveryMs;
  const excessMs = stage.stragglerExcessMs ?? 0;
  const slots = stage.peakConcurrentTasks ?? 0;
  if (excessMs <= 0 || slots <= 0) return singleTaskExcessMs;
  return Math.max(singleTaskExcessMs, excessMs / slots);
}

// Task time a skew/straggler fix removes, by the same measure: the tasks over 4x P50 capped at the
// median (stragglerExcessMs), or the slowest task's excess when that alone is larger.
export function tailRemovedWorkMs(stage: TailStage, singleTaskExcessMs: number): number {
  return Math.max(singleTaskExcessMs, stage.stragglerExcessMs ?? 0);
}

// Longest task a straggler fix leaves: every task over 4x P50 comes down to the median, so the
// longest one at or under that (finalizeStage's longestNonStragglerMs). Without stragglers (a
// speculation-driven finding) or the field (older snapshots), the median.
export function stragglerFixLongestTaskMs(stage: TailStage): number {
  const p50 = stage.taskDurationP50 ?? 0;
  if (!((stage.stragglerCount ?? 0) > 0) || stage.longestNonStragglerMs == null) return p50;
  return Math.max(p50, stage.longestNonStragglerMs);
}

export interface SingleStageEstimateOptions {
  // The claim shortens the stage's longest task itself (skew, straggler): `ceiling`'s
  // taskDurationMax term is the very quantity being fixed, so clipping against it would cap a
  // one-straggler stage's claim at ~0. Such a claim is floored instead at the longest task the
  // fix leaves (taskDurationMax - claim) or the stage's core work spread over every core.
  shortensLongestTask?: boolean;
  // Core work (task time) the fix itself removes (tailRemovedWorkMs): the core-work floor is then
  // the work left after it. Flooring a tail fix at the stage's work before the fix held back most
  // of the claim on stages whose stragglers were a large part of their core time.
  removedCoreWorkMs?: number;
  // Longest task the fix leaves, when known (stragglerFixLongestTaskMs): the stage can't finish
  // before it, however much of the tail the claim spreads over the stage's slots.
  longestTaskAfterFixMs?: number;
}

/**
 * Per-finding estimate for a single-stage waste claim. Returns null when the
 * stage was excluded from the sweep (duration <= 0): callers must fall back
 * to a resourceOnly/informational basis with wallClock: null, never a fake
 * {0, 0}.
 */
export function estimateSingleStage(
  wasteMsClaimed: number,
  stageId: number,
  stages: Map<number, OccupancyStage>,
  info: Map<number, StageOccupancyInfo>,
  { shortensLongestTask = false, removedCoreWorkMs = 0, longestTaskAfterFixMs = 0 }: SingleStageEstimateOptions = {},
): OccupancyEstimate | null {
  const stage = stages.get(stageId);
  const stageInfo = info.get(stageId);
  if (!stage || !stageInfo) return null;
  const coreWork = stage.executorRunTime ?? 0;
  const coreWorkFloor = removedCoreWorkMs > 0 && coreWork > 0
    ? stageInfo.coreWorkFloor * Math.max(0, 1 - removedCoreWorkMs / coreWork)
    : stageInfo.coreWorkFloor;
  const ceiling = shortensLongestTask
    ? Math.max((stage.taskDurationMax ?? 0) - wasteMsClaimed, longestTaskAfterFixMs, coreWorkFloor)
    : stageInfo.ceiling;
  const clipped = clipToCeiling(wasteMsClaimed, stage, ceiling);
  if (stageInfo.gate >= SERIAL_GATE_THRESHOLD) {
    return { basis: 'serial', wallClock: { low: clipped, high: clipped } };
  }
  return { basis: 'contended', wallClock: { low: clipped * stageInfo.gate, high: clipped } };
}

/**
 * Sum-then-cap over a finding's own stages: the union of the finding's own
 * stage windows bounds the joint claim, so two overlapping stages' waste
 * can't be double-counted. Returns null only when every one of the
 * finding's stages was excluded from the sweep.
 */
export function estimateMultiStage(
  stageIds: number[],
  wasteMsByStage: Map<number, number>,
  stages: Map<number, OccupancyStage>,
  info: Map<number, StageOccupancyInfo>,
): OccupancyEstimate | null {
  const perStage: OccupancyEstimate[] = [];
  const intervals: [number, number][] = [];
  for (const id of stageIds) {
    const est = estimateSingleStage(wasteMsByStage.get(id) ?? 0, id, stages, info);
    if (!est) continue;
    perStage.push(est);
    const stage = stages.get(id)!;
    intervals.push([stage.submittedAt ?? 0, stage.completedAt ?? 0]);
  }
  if (perStage.length === 0) return null;
  const sumHigh = perStage.reduce((sum, e) => sum + e.wallClock.high, 0);
  const sumLow = perStage.reduce((sum, e) => sum + e.wallClock.low, 0);
  const unionMs = mergeIntervals(intervals).reduce((sum, [a, b]) => sum + (b - a), 0);
  const high = Math.min(sumHigh, unionMs);
  const low = Math.min(sumLow, unionMs);
  // Numeric low === high isn't enough: the union cap can force that equality
  // even when the constituent stages were individually contended (e.g. two
  // fully-overlapping stages each at gate 0.5). Only claim 'serial' when
  // every contributing per-stage estimate was itself serial.
  const basis = perStage.every((e) => e.basis === 'serial') ? 'serial' : 'contended';
  return { basis, wallClock: { low, high } };
}
