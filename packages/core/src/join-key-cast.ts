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
const USER_SHUFFLE_ORIGIN = /\b(REPARTITION_BY_\w+|REBALANCE_PARTITIONS_BY_\w+)\b/;
// The join sides whose partitioning a shuffled join reports as its own output partitioning.
const partitioningSides = (joinType: string, left: string[], right: string[]): string[][] => {
  if (joinType === 'Inner' || joinType === 'Cross') return [left, right];
  if (joinType === 'LeftOuter' || joinType === 'LeftSemi' || joinType === 'LeftAnti' || joinType === 'ExistenceJoin') return [left];
  if (joinType === 'RightOuter') return [right];
  return [];
};
const uncast = (key: string) => (key.startsWith('cast(') ? CAST_OF_COLUMN.exec(key)?.[1] : key.trim());

/** The cast keys of a shuffled join and the next exchange that shuffles by a column they cast, or
 * null. The exchange counts only when Spark added it and it would go without the cast: every key
 * of one cast side that gives the join's output partitioning, cast removed, is among its hash keys. `parents` maps each plan node to its
 * parent. An operator that consumes the join's partitioning (another join, a window, a final
 * aggregate) ends the search: no exchange follows the join for it. */
export function joinKeyCastOf(join: PlanNode, parents: ReadonlyMap<PlanNode, PlanNode | null>): JoinKeyCast | null {
  const keys = parseJoinKeys(join.detail ?? '');
  if (!keys || !isShuffledJoin(keys.operator)) return null;
  const casts = [...keys.leftKeys, ...keys.rightKeys].filter((key) => key.startsWith('cast('));
  if (casts.length === 0) return null;
  const castColumns = new Set(casts.flatMap((key) => CAST_OF_COLUMN.exec(key)?.[1] ?? []));
  const castSides = partitioningSides(keys.joinType, keys.leftKeys, keys.rightKeys).filter((side) => side.some((key) => key.startsWith('cast(')));

  for (let node = parents.get(join) ?? null; node; node = parents.get(node) ?? null) {
    const detail = node.detail ?? '';
    if (isExchangeNode(node)) {
      if (node.exchangeRole === 'write') continue;
      if (USER_SHUFFLE_ORIGIN.test(detail)) return null;
      const hashKeys = new Set(partitioningArgs(detail, 'hash')?.keys.map((key) => key.trim()) ?? []);
      if (!castSides.some((side) => side.every((key) => hashKeys.has(uncast(key) ?? '')))) return null;
      const exchangeKeys = [...hashKeys].filter((key) => castColumns.has(key));
      return { operator: keys.operator, castKeys: [...new Set(casts.map(stripIds))], exchange: node, exchangeKeys: exchangeKeys.map(stripIds) };
    }
    if (/Join|Window/.test(node.name) || (/Aggregate/.test(node.name) && !/\bpartial_/.test(detail))) return null;
  }
  return null;
}
