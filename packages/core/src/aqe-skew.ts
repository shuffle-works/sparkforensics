// Why AQE skew-join handling did or did not act on a stage's join, read from the execution's final
// plan and the effective Spark conf. Spark's OptimizeSkewedJoin splits a skewed shuffle partition
// only when every condition below holds (https://github.com/apache/spark/blob/v3.5.0/sql/core/src/main/scala/org/apache/spark/sql/execution/adaptive/OptimizeSkewedJoin.scala):
//   - the join is a sort-merge or shuffled-hash join whose two inputs are materialized shuffle
//     stages Spark added for the join (ENSURE_REQUIREMENTS), under a Sort for a sort-merge join;
//   - the join type lets the skewed side be split (left side for Inner, Cross, LeftOuter, LeftSemi
//     and LeftAnti, right side for Inner, Cross and RightOuter);
//   - the partition is over both skewedPartitionThresholdInBytes and skewedPartitionFactor times the
//     median partition;
//   - splitting adds no shuffle for the operators above the join, unless forceOptimizeSkewedJoin.
// The final plan shows a split (`skew=true` on the join, `AQEShuffleRead skewed`) and the shape the
// rule matches, so the first condition that fails is the reason.
import type { PlanNode } from './types.ts';
import type { AqeSkewCase, Remediation } from './finding-types.ts';
import { formatBytes } from './format-utils.ts';
import { walkPlanTree } from './plan-tree-walk.ts';
import { codeFix, decreaseConf, setConf } from './remediation.ts';
import { parseSparkBytes, sparkConfDefault } from './spark-conf.ts';

export const SKEW_THRESHOLD_KEY = 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes';
export const SKEW_FACTOR_KEY = 'spark.sql.adaptive.skewJoin.skewedPartitionFactor';
export const FORCE_SKEW_JOIN_KEY = 'spark.sql.adaptive.forceOptimizeSkewedJoin';
const ADVISORY_SIZE_KEY = 'spark.sql.adaptive.advisoryPartitionSizeInBytes';

export interface JoinSkewDiagnosis {
  case: AqeSkewCase;
  /** A clause that reads after "the stage is skewed:", ending without a period. */
  text: string;
  remediation: Remediation[];
}

export interface JoinSkewInput {
  /** The SQL execution's resolved plan. */
  plan: PlanNode | null | undefined;
  stageId: number;
  /** The stage's task-level shuffle read: the largest task and the median task, in bytes. */
  readMax: number;
  readP50: number;
  /** The effective value of a property for this execution (null when not logged and no default). */
  conf(key: string): string | undefined;
  /** The run's Spark version, which decides whether forceOptimizeSkewedJoin exists. */
  sparkVersion: string | null | undefined;
  /** The advice for a skew nothing but the job's code can fix. */
  keyRemedy: string;
}

/** The joins AQE skew-join handling applies to; the name carries `(skew=true)` once it split one. */
const JOIN_NAME = /^(SortMergeJoin|ShuffledHashJoin)(\(skew=true\))?$/;
export const isSkewJoinNode = (name: string): boolean => JOIN_NAME.test(name);
// Operators that wrap a shuffle read without changing what the join reads.
const WRAPPER_NAME = /^(WholeStageCodegen|InputAdapter$|AQEShuffleRead$|CustomShuffleReader$|ColumnarToRow$)/;
const SHUFFLE_READ_NAME = /^(AQEShuffleRead|CustomShuffleReader)$/;
const SPLITTABLE_LEFT = new Set(['Inner', 'Cross', 'LeftSemi', 'LeftAnti', 'LeftOuter']);
const SPLITTABLE_RIGHT = new Set(['Inner', 'Cross', 'RightOuter']);
const JOIN_TYPE = /\]\s*,\s*(Inner|Cross|LeftOuter|RightOuter|FullOuter|LeftSemi|LeftAnti|ExistenceJoin)\b/;
// A partition is only clearly skewed when the largest task read is at least this many times the median.
const SKEWED_READ_RATIO = 2;
const SHUFFLE_ORIGIN = /\b(ENSURE_REQUIREMENTS|REPARTITION_BY_COL|REPARTITION_BY_NUM|REBALANCE_PARTITIONS_BY_NONE|REBALANCE_PARTITIONS_BY_COL)\b/;

/** What one join input reads: a shuffle Spark added for the join, a shuffle the job asked for, or
 * some other operator (the join reads from it, not from a shuffle). */
type SideInput =
  | { kind: 'joinShuffle'; coalesced: boolean }
  | { kind: 'userShuffle'; hint: 'repartition' | 'rebalance'; coalesced: boolean }
  | { kind: 'operator'; name: string };

interface JoinInfo {
  node: PlanNode;
  /** Ancestors, nearest first. */
  ancestors: PlanNode[];
}

function metricValue(node: PlanNode, name: string): number | null {
  return node.metrics?.find((m) => m.name === name)?.value ?? null;
}

// Follows one join input down through wrappers (and the Sort a sort-merge join puts over its
// shuffle) to the operator that produces it.
function classifySide(input: PlanNode | undefined): { side: SideInput; reads: PlanNode[] } {
  const reads: PlanNode[] = [];
  let node = input;
  let sortSeen = false;
  while (node != null) {
    if (SHUFFLE_READ_NAME.test(node.name)) reads.push(node);
    if (WRAPPER_NAME.test(node.name) || (node.name === 'Sort' && !sortSeen)) {
      if (node.name === 'Sort') sortSeen = true;
      node = node.children[0];
      continue;
    }
    break;
  }
  const coalesced = reads.some((r) => /\bcoalesced\b/.test(r.detail ?? ''));
  if (node == null) return { side: { kind: 'operator', name: 'an unknown operator' }, reads };
  if (node.name === 'ShuffleQueryStage') {
    const origin = SHUFFLE_ORIGIN.exec(node.children[0]?.detail ?? '')?.[1];
    if (origin == null || origin === 'ENSURE_REQUIREMENTS') return { side: { kind: 'joinShuffle', coalesced }, reads };
    return { side: { kind: 'userShuffle', hint: origin.startsWith('REBALANCE') ? 'rebalance' : 'repartition', coalesced }, reads };
  }
  return { side: { kind: 'operator', name: node.name }, reads };
}

function describeOperator(name: string): string {
  if (/Aggregate$/.test(name)) return 'an aggregate';
  if (/^Window/.test(name)) return 'a window';
  if (/Scan/.test(name)) return 'a scan';
  return `a ${name} operator`;
}

// Whether an operator above the join needs the join's output partitioning, so a split (which
// breaks it) would cost a shuffle. Stops at the first exchange: the stage boundary above it
// reshuffles anyway. A partial aggregate asks for no distribution.
function needsJoinPartitioning(ancestors: PlanNode[]): string | null {
  for (const a of ancestors) {
    if (/Exchange$|^ShuffleQueryStage$/.test(a.name)) return null;
    if (/Aggregate$/.test(a.name) && !/partial_/.test(a.detail ?? '')) return 'an aggregate';
    if (/^Window/.test(a.name)) return 'a window';
    if (JOIN_NAME.test(a.name)) return 'another join';
  }
  return null;
}

function collectJoins(root: PlanNode): JoinInfo[] {
  const parents = new Map<PlanNode, PlanNode | null>();
  const joins: PlanNode[] = [];
  walkPlanTree(root, (node, parent) => {
    parents.set(node, parent);
    if (JOIN_NAME.test(node.name)) joins.push(node);
  });
  return joins.map((node) => {
    const ancestors: PlanNode[] = [];
    for (let p = parents.get(node) ?? null; p != null; p = parents.get(p) ?? null) ancestors.push(p);
    return { node, ancestors };
  });
}

function sideNoun(index: 0 | 1): 'left' | 'right' { return index === 0 ? 'left' : 'right'; }

function diagnoseJoin(join: JoinInfo, input: JoinSkewInput): JoinSkewDiagnosis | null {
  const { node } = join;
  const left = classifySide(node.children[0]);
  const right = classifySide(node.children[1]);
  const reads = [...left.reads, ...right.reads];

  // Split: the join carries `skew=true` and a read on one side says `skewed`.
  const splitReads = reads.filter((r) => /\bskewed\b/.test(r.detail ?? ''));
  if (/\(skew=true\)$/.test(node.name) || splitReads.length > 0) {
    const partitions = splitReads.reduce((sum, r) => sum + (metricValue(r, 'number of skewed partitions') ?? 0), 0);
    const splits = splitReads.reduce((sum, r) => sum + (metricValue(r, 'number of skewed partition splits') ?? 0), 0);
    const what = partitions > 0 && splits > 0
      ? `AQE already split ${partitions} skewed partition${partitions === 1 ? '' : 's'} into ${splits} tasks`
      : 'AQE already split the skewed partitions';
    return {
      case: 'split',
      text: `${what}, so the imbalance that remains is not join skew: look for a GC pause, a slow host or an expensive key instead`,
      remediation: [],
    };
  }

  // Even reads: with the largest task read close to the median, no partition stands out for AQE to
  // split. A coalesced read is a sum of partitions, so its ratio says nothing about one partition.
  const coalesced = (left.side.kind !== 'operator' && left.side.coalesced) || (right.side.kind !== 'operator' && right.side.coalesced);
  const ratio = input.readP50 > 0 ? Math.round(input.readMax / input.readP50 * 10) / 10 : null;
  if (!coalesced && input.readP50 > 0 && input.readMax < SKEWED_READ_RATIO * input.readP50) {
    return {
      case: 'evenReads',
      text: `its shuffle reads are even (the largest task reads ${formatBytes(input.readMax)}, ${ratio}× the median), so AQE has no skewed partition to split and the slow tail is not partition-size skew: look for a GC pause, a slow host or an expensive key instead`,
      remediation: [],
    };
  }

  // Plan shape: both inputs must be shuffles Spark added for this join.
  const blocked = [left.side, right.side].map((s, i) => ({ s, i: i as 0 | 1 })).find((x) => x.s.kind === 'operator');
  if (blocked?.s.kind === 'operator') {
    const above = describeOperator(blocked.s.name);
    return {
      case: 'planShape',
      text: `AQE skew-join handling cannot apply: the join's ${sideNoun(blocked.i)} input comes from ${above} instead of a shuffle, and AQE splits only a shuffle that feeds the join directly; ${input.keyRemedy}`,
      remediation: [codeFix(input.keyRemedy)],
    };
  }
  const user = [left.side, right.side].find((s) => s.kind === 'userShuffle');
  if (user?.kind === 'userShuffle') {
    return {
      case: 'userRepartition',
      text: `a ${user.hint} you wrote feeds the join, and AQE leaves a shuffle you asked for as it is (it splits only shuffles Spark added for the join): drop the ${user.hint} so the join's own shuffle can be split, or ${input.keyRemedy}`,
      remediation: [codeFix(`drop the explicit ${user.hint} ahead of the join, or ${input.keyRemedy}`)],
    };
  }

  // Join type: which sides AQE may split.
  const joinType = JOIN_TYPE.exec(node.detail ?? '')?.[1];
  const canLeft = joinType != null && SPLITTABLE_LEFT.has(joinType);
  const canRight = joinType != null && SPLITTABLE_RIGHT.has(joinType);
  if (joinType != null && !canLeft && !canRight) {
    return {
      case: 'joinType',
      text: `AQE never splits either side of a ${joinType} join: join the hot key on its own and union the results, or ${input.keyRemedy}`,
      remediation: [codeFix(`join the hot key separately and union the results, or ${input.keyRemedy}`)],
    };
  }

  // Thresholds. A task reads one partition of each side (more when AQE coalesced them), so the
  // task's read is an upper bound on any one partition: a task under the threshold proves no
  // partition is over it. The factor and a coalesced stage's reads are only comparable when the
  // read is not a sum of coalesced partitions.
  const threshold = parseSparkBytes(input.conf(SKEW_THRESHOLD_KEY));
  const factor = Number.parseFloat(input.conf(SKEW_FACTOR_KEY) ?? '');
  const underThreshold = threshold != null && input.readMax <= threshold;
  const underFactor = !coalesced && Number.isFinite(factor) && input.readP50 > 0 && input.readMax <= factor * input.readP50;
  const biggest = `its largest shuffle partition (${formatBytes(input.readMax)})`;
  if (underThreshold && underFactor) {
    return {
      case: 'belowThreshold',
      text: `${biggest} is under the ${input.conf(SKEW_THRESHOLD_KEY)} threshold (${SKEW_THRESHOLD_KEY}) and only ${ratio}× the median, under the ${factor}× factor (${SKEW_FACTOR_KEY}) AQE needs before it treats a partition as skewed, so lower both for this query`,
      remediation: [decreaseConf(SKEW_THRESHOLD_KEY), decreaseConf(SKEW_FACTOR_KEY)],
    };
  }
  if (underThreshold) {
    return {
      case: 'belowThreshold',
      text: `${biggest} is under the ${input.conf(SKEW_THRESHOLD_KEY)} AQE needs before it treats a partition as skewed (${SKEW_THRESHOLD_KEY}), so lower the threshold for this query`,
      remediation: [decreaseConf(SKEW_THRESHOLD_KEY)],
    };
  }
  if (underFactor) {
    return {
      case: 'belowThreshold',
      text: `${biggest} is only ${ratio}× the median, under the ${factor}× AQE needs before it treats a partition as skewed (${SKEW_FACTOR_KEY}), so lower the factor for this query`,
      remediation: [decreaseConf(SKEW_FACTOR_KEY)],
    };
  }
  const advisory = parseSparkBytes(input.conf(ADVISORY_SIZE_KEY));
  // Coalescing merges small partitions up to the advisory size on each side, so a task read below
  // twice that can be many partitions that are each under the threshold.
  if (coalesced && advisory != null && input.readMax <= 2 * advisory) return null;

  const needing = needsJoinPartitioning(join.ancestors);
  // forceOptimizeSkewedJoin exists from Spark 3.3 (no default before), so earlier runs get the key
  // remedy even when they log the property.
  const canForce = sparkConfDefault(input.sparkVersion, FORCE_SKEW_JOIN_KEY) != null;
  const forced = canForce && input.conf(FORCE_SKEW_JOIN_KEY)?.toLowerCase() === 'true';
  const extraShuffleText = needing == null || forced ? null
    : `AQE skipped splitting it because ${needing} above the join needs the join's partitioning and a split would add a shuffle: ${canForce ? `set ${FORCE_SKEW_JOIN_KEY}=true if that shuffle costs less than the tail, or ` : ''}${input.keyRemedy}`;

  if (joinType != null && canLeft !== canRight) {
    const only = canLeft ? 'left' : 'right';
    const other = canLeft ? 'right' : 'left';
    const tail = needing == null || forced ? ''
      : `; if the skew is on the ${only} side, AQE skipped it because ${needing} above the join needs the join's partitioning and a split would add a shuffle${canForce ? ` (${FORCE_SKEW_JOIN_KEY}=true accepts that)` : ''}`;
    return {
      case: 'joinType',
      text: `AQE can split only the ${only} side of a ${joinType} join, so a skewed partition on the ${other} side stays whole: if that is where the skew is, rewrite the join so the skewed table is on the ${only} side, or ${input.keyRemedy}${tail}`,
      remediation: [codeFix(`put the skewed table on the ${only} side of the join, or ${input.keyRemedy}`), ...(tail && canForce ? [setConf(FORCE_SKEW_JOIN_KEY, true)] : [])],
    };
  }
  if (extraShuffleText != null) {
    return { case: 'extraShuffle', text: extraShuffleText, remediation: [canForce ? setConf(FORCE_SKEW_JOIN_KEY, true) : codeFix(input.keyRemedy)] };
  }
  return {
    case: 'notSplit',
    text: `AQE did not split it although the partition is over the thresholds and the plan allows it, and the log does not say why (a partition built from a single map task cannot be split, for one): ${input.keyRemedy}`,
    remediation: [codeFix(input.keyRemedy)],
  };
}

/** Which of Spark's skew-join conditions applies to the join running in `stageId`, or null when
 * the plan cannot say: it is not a final adaptive plan, no join can be tied to the stage, or the
 * stage's read is inconclusive (a coalesced read that may be a sum of small partitions). */
export function diagnoseJoinSkew(input: JoinSkewInput): JoinSkewDiagnosis | null {
  const { plan } = input;
  if (plan == null || plan.name !== 'AdaptiveSparkPlan' || !/isFinalPlan=true/.test(plan.detail ?? '')) return null;
  const joins = collectJoins(plan);
  let chosen = joins.filter((j) => j.node.stageIds?.includes(input.stageId));
  // A plan whose joins carry no stage ids at all can still be read when it has a single join.
  if (chosen.length === 0 && joins.length === 1 && !joins[0].node.stageIds?.length) chosen = joins;
  const diagnoses = chosen.map((j) => diagnoseJoin(j, input)).filter((d): d is JoinSkewDiagnosis => d != null);
  return diagnoses.find((d) => d.case === 'split') ?? diagnoses[0] ?? null;
}
