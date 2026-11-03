import { indexStagesBySqlExecution } from '../sql-stages.ts';
import type { PlanNode } from '../types.ts';
import type { DetectorCtx } from './types.ts';

// The ids of the stages a SQL execution ran: one index over the run's stages, shared by every
// execution's detect() instead of a scan of all stages each. A copy, as findings keep the array.
export function sqlStageIds(ctx: DetectorCtx, executionId: number): number[] {
  ctx.stagesBySqlExecution ??= indexStagesBySqlExecution(ctx.stages);
  return ctx.stagesBySqlExecution.get(executionId)?.slice() ?? [];
}

// Shared by the three Plan Advisor detectors: union the given nodes' own stageIds, or fall back
// to the whole execution's stage set when none have coverage (never a partial blend). `fallback`
// is a param so callers compute sqlStageIds once per detect() and reuse it per finding.
export function unionStageIds(nodes: PlanNode[], fallback: number[]): number[] {
  const union = new Set<number>();
  for (const node of nodes) for (const sid of node.stageIds ?? []) union.add(sid);
  if (union.size > 0) return [...union].sort((a, b) => a - b);
  executionWideStageIds.add(fallback);
  return fallback;
}

// The fallback arrays unionStageIds returned: the whole execution's stages, not the stages the
// finding ran on, so their task time is not the finding's.
const executionWideStageIds = new WeakSet<number[]>();

export function isExecutionWideStageIds(stageIds: number[]): boolean {
  return executionWideStageIds.has(stageIds);
}
