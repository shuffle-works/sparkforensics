import type { PlanNode, SqlExecution, Stage } from './types.ts';

/** The plan nodes a stage actually ran: its SQL execution's resolved plan tree, filtered to the
 * nodes attributed to it (`node.stageIds`). Empty when the stage has no SQL execution, the
 * execution has no resolved plan, or no node is attributed to it. The one stage-to-plan mapping:
 * stageIdentity's fingerprint and the Python-stage check both read it. */
export function planNodesOfStage(stage: Pick<Stage, 'id' | 'sqlExecutionId'>, sql: Map<number, SqlExecution>): PlanNode[] {
  const execId = stage.sqlExecutionId;
  if (execId == null) return [];
  const root = sql.get(execId)?.planTree ?? null;
  if (!root) return [];
  const nodes: PlanNode[] = [];
  (function collect(node: PlanNode): void {
    if (node.stageIds?.includes(stage.id)) nodes.push(node);
    for (const child of node.children ?? []) collect(child);
  })(root);
  return nodes;
}
