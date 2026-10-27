// Finds a shuffled join whose key carries a cast, followed by an exchange on the uncast column.
//
// Spark coerces a join of two different numeric types by casting a side (or both) inside the join
// key, and shuffles each side by the cast key. The join's output is then partitioned by that cast
// expression, so a later operator that needs the plain column (a window, a final aggregate, another
// join) cannot reuse it and adds an exchange of its own.
import type { PlanNode } from './types.ts';
import type { JoinKeyCastEvidence } from './finding-types.ts';
import { isExchangeNode } from './plan-node-detail.ts';
import { parseJoinKeys, partitioningArgs } from './plan-summary.ts';

export interface JoinKeyCast {
  operator: JoinKeyCastEvidence['nodeName'];
  /** The cast key expressions, expression ids removed. */
  castKeys: string[];
  /** The exchange that shuffles again, on a column the join cast. */
  exchange: PlanNode;
  /** The exchange's keys that are a column the join cast, expression ids removed. */
  exchangeKeys: string[];
}

const isShuffledJoin = (operator: string): operator is JoinKeyCast['operator'] => operator === 'SortMergeJoin' || operator === 'ShuffledHashJoin';
// cast(<column> as <type>): the column is what a later exchange would shuffle by without the cast.
const CAST_OF_COLUMN = /^cast\(([^\s()]+#\d+\w*) as /;
const stripIds = (text: string) => text.replace(/#\w+/g, '');

/** The cast keys of a shuffled join and the next exchange that shuffles by a column they cast, or
 * null. `parents` maps each plan node to its parent. An operator that consumes the join's
 * partitioning (another join, a window, a final aggregate) ends the search: no exchange follows
 * the join for it. */
export function joinKeyCastOf(join: PlanNode, parents: ReadonlyMap<PlanNode, PlanNode | null>): JoinKeyCast | null {
  const keys = parseJoinKeys(join.detail ?? '');
  if (!keys || !isShuffledJoin(keys.operator)) return null;
  const casts = [...keys.leftKeys, ...keys.rightKeys].filter((key) => key.startsWith('cast('));
  if (casts.length === 0) return null;
  const castColumns = new Set(casts.flatMap((key) => CAST_OF_COLUMN.exec(key)?.[1] ?? []));

  for (let node = parents.get(join) ?? null; node; node = parents.get(node) ?? null) {
    const detail = node.detail ?? '';
    if (isExchangeNode(node)) {
      if (node.exchangeRole === 'write') continue;
      const exchangeKeys = partitioningArgs(detail, 'hash')?.keys.filter((key) => castColumns.has(key.trim())) ?? [];
      if (exchangeKeys.length === 0) return null;
      return { operator: keys.operator, castKeys: [...new Set(casts.map(stripIds))], exchange: node, exchangeKeys: exchangeKeys.map(stripIds) };
    }
    if (/Join|Window/.test(node.name) || (/Aggregate/.test(node.name) && !/\bpartial_/.test(detail))) return null;
  }
  return null;
}
