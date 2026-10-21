// Shared by every scope:'sql' detector and the plan views. sql.get(id).stageIds is always empty
// (see detector-contract/plan-attribution.md), so stages are linked by their own sqlExecutionId.
// Minimal param shape (not DetectorStage): external callers pass Map<StageId, Stage>.
export function stageIdsForSqlExec(
  executionId: number,
  stages: Map<number, { id: number; sqlExecutionId?: number | null }>,
): number[] {
  const out: number[] = [];
  for (const s of stages.values()) if (s.sqlExecutionId === executionId) out.push(s.id);
  return out;
}

// Every execution's stage ids in one pass over the stages, in stage order: the lookup for a caller
// that asks about many executions, where one stageIdsForSqlExec scan per execution is quadratic.
export function indexStagesBySqlExecution(
  stages: Map<number, { id: number; sqlExecutionId?: number | null }>,
): Map<number, number[]> {
  const index = new Map<number, number[]>();
  for (const s of stages.values()) {
    if (s.sqlExecutionId == null) continue;
    const ids = index.get(s.sqlExecutionId);
    if (ids) ids.push(s.id);
    else index.set(s.sqlExecutionId, [s.id]);
  }
  return index;
}
