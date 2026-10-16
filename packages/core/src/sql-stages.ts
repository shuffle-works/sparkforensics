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
