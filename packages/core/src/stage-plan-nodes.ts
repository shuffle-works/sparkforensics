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
  return [...(nodesByStage(root).get(stage.id) ?? [])];
}

// One preorder walk per resolved plan tree serves every stage of its execution. A resolved tree is
// never mutated after the parser posts it, so keying by root identity is safe.
const nodesByStageCache = new WeakMap<PlanNode, Map<number, PlanNode[]>>();

function nodesByStage(root: PlanNode): Map<number, PlanNode[]> {
  const cached = nodesByStageCache.get(root);
  if (cached) return cached;
  const index = new Map<number, PlanNode[]>();
  (function collect(node: PlanNode): void {
    for (const id of new Set(node.stageIds ?? [])) {
      const list = index.get(id);
      if (list) list.push(node); else index.set(id, [node]);
    }
    for (const child of node.children ?? []) collect(child);
  })(root);
  nodesByStageCache.set(root, index);
  return index;
}
