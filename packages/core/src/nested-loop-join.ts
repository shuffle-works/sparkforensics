// Reads a nested-loop join's operator, join type and condition from its plan line, and the row
// counts around it from the executors' "number of output rows" metric.
//
// Spark plans a join with no equi-join keys as a BroadcastNestedLoopJoin when one side can be
// broadcast, else a CartesianProduct for an inner-like join (JoinSelection in
// sql/core/src/main/scala/org/apache/spark/sql/execution/SparkStrategies.scala, v3.5.0). Both
// compare every left row with every right row.
import type { PlanNode } from './types.ts';

export type NestedLoopOperator = 'BroadcastNestedLoopJoin' | 'CartesianProduct';

export interface NestedLoopJoinShape {
  operator: NestedLoopOperator;
  /** Spark's join type as printed (Inner, Cross, LeftOuter...), null when the line has none. */
  joinType: string | null;
  /** The join condition with expression ids removed, null for a join without one. */
  condition: string | null;
}

const OUTPUT_ROWS = 'number of output rows';

// BroadcastNestedLoopJoin <BuildLeft|BuildRight>, <JoinType>[, <condition>]
const BNLJ_LINE = /^BroadcastNestedLoopJoin\s+Build(?:Left|Right),\s*(\w+)(?:,\s*([\s\S]+))?$/;
// CartesianProduct[ <condition>]: the operator only plans inner-like joins and prints no type.
const CARTESIAN_LINE = /^CartesianProduct(?:\s+([\s\S]+))?$/;

function cleanCondition(raw: string | undefined): string | null {
  const text = (raw ?? '').replace(/#\d+L?/g, '').trim();
  return text.length > 0 ? text : null;
}

/** The nested-loop operator, join type and condition behind a plan node, or null for any other node. */
export function parseNestedLoopJoin(node: Pick<PlanNode, 'name' | 'detail'>): NestedLoopJoinShape | null {
  const detail = (node.detail ?? '').trim();
  if (node.name === 'BroadcastNestedLoopJoin') {
    const m = detail.match(BNLJ_LINE);
    return { operator: 'BroadcastNestedLoopJoin', joinType: m?.[1] ?? null, condition: cleanCondition(m?.[2]) };
  }
  if (node.name === 'CartesianProduct') {
    const m = detail.match(CARTESIAN_LINE);
    return { operator: 'CartesianProduct', joinType: 'Inner', condition: cleanCondition(m?.[1]) };
  }
  return null;
}

// Operators that pass every row of their one child through, so the child's row count is theirs.
// A node outside this list that reports no row metric (Expand, Union, Limit...) can change the
// count, so the walk stops there rather than guess.
const ROW_PRESERVING = new Set([
  'WholeStageCodegen', 'InputAdapter', 'Project', 'Sort', 'Exchange', 'BroadcastExchange',
  'ShuffleQueryStage', 'BroadcastQueryStage', 'AQEShuffleRead', 'CustomShuffleReader',
  'ColumnarToRow', 'AdaptiveSparkPlan',
]);

/** The rows a subtree produced: the nearest "number of output rows" at or below `node`, walking
 * through row-preserving single-child operators. Null when the log reports none for it. */
export function outputRowsOf(node: PlanNode): number | null {
  let current: PlanNode | undefined = node;
  while (current) {
    const metric = current.metrics?.find((m) => m.name === OUTPUT_ROWS);
    if (metric) return metric.value;
    const preserving = ROW_PRESERVING.has(current.name) || /^WholeStageCodegen/.test(current.name);
    if (!preserving || current.children.length !== 1) return null;
    current = current.children[0];
  }
  return null;
}

/** The node's own "number of output rows" value, null when absent. */
export function ownOutputRows(node: PlanNode): number | null {
  const metric = node.metrics?.find((m) => m.name === OUTPUT_ROWS);
  return metric ? metric.value : null;
}
