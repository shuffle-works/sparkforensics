import type { AppModel, PlanNode, StageId } from '@sparkforensics/core/types';

/** Resolves the SQL plan tree linked to a stage, or null if the stage has no SQL execution or that
 * execution has no plan tree. The one lookup behind whether a stage has plan context to show: a
 * widget's rows decide it with this, and `PlanView` renders from it. */
export function resolvePlanTree(stageId: StageId, appModel: AppModel): PlanNode | null {
  const stage = appModel.stages.get(stageId);
  const linkedSql = stage?.sqlExecutionId != null ? appModel.sql.get(stage.sqlExecutionId) : null;
  return linkedSql?.planTree ?? null;
}
