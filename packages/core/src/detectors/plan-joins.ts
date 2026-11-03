import { parseJoinType } from '../plan-summary.ts';
import { isExchangeNode, isBroadcastExchangeNode } from '../plan-node-detail.ts';
import type { PlanNode } from '../types.ts';

// A join side's shuffle: the Exchange node whose "data size" is that side's runtime size. AQE
// decides broadcast from the same metric (ShuffleExchangeExec.runtimeStatistics, apache/spark
// v3.5.0). Only operators that pass rows through unchanged are looked through, so a side that is
// another join's output, an aggregate, or a reused exchange has no size of its own and yields null.
const SHUFFLE_PASS_THROUGH = /^(Sort|InputAdapter|WholeStageCodegen|ShuffleQueryStage|AQEShuffleRead|CustomShuffleReader)\b/;

export function joinSideShuffle(node: PlanNode): PlanNode | null {
  if (node.name === 'ReusedExchange') return null;
  const dataSize = (node.metrics ?? []).some((m) => m.name === 'data size');
  if (isExchangeNode(node) && !isBroadcastExchangeNode(node.name) && dataSize) return node;
  const children = node.children ?? [];
  if (children.length !== 1 || !(isExchangeNode(node) || SHUFFLE_PASS_THROUGH.test(node.name))) return null;
  return joinSideShuffle(children[0]);
}

export function shuffleBytes(exchange: PlanNode): number {
  return (exchange.metrics ?? []).find((m) => m.name === 'data size')?.value ?? 0;
}

// The join types a side can be the broadcast build side of, per canBuildBroadcastLeft/Right in
// JoinSelectionHelper (apache/spark v3.5.0, v4.0.0 adds LeftSingle on the right). A full outer
// join builds from neither side, and an unrecognized type is not guessed at.
const BROADCAST_BUILD_LEFT: ReadonlySet<string> = new Set(['Inner', 'Cross', 'RightOuter']);
const BROADCAST_BUILD_RIGHT: ReadonlySet<string> = new Set(['Inner', 'Cross', 'LeftOuter', 'LeftSingle', 'LeftSemi', 'LeftAnti', 'ExistenceJoin']);

interface BroadcastCandidate {
  joinType: string;
  buildSide: 'left' | 'right';
  build: PlanNode;
  stream: PlanNode;
}

// The smaller of the sides this join's type can broadcast. Both sides need a measurable size of
// their own, so the candidate is never compared with an unknown partner.
export function broadcastCandidate(join: PlanNode): BroadcastCandidate | null {
  const joinType = parseJoinType(join.detail ?? '');
  if (joinType == null || (join.children ?? []).length !== 2) return null;
  const left = joinSideShuffle(join.children[0]);
  const right = joinSideShuffle(join.children[1]);
  if (!left || !right) return null;
  const options: BroadcastCandidate[] = [];
  if (BROADCAST_BUILD_LEFT.has(joinType)) options.push({ joinType, buildSide: 'left', build: left, stream: right });
  if (BROADCAST_BUILD_RIGHT.has(joinType)) options.push({ joinType, buildSide: 'right', build: right, stream: left });
  return options.reduce<BroadcastCandidate | null>((best, o) => (best == null || shuffleBytes(o.build) < shuffleBytes(best.build) ? o : best), null);
}
