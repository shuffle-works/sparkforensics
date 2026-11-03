import { walkPlanTree } from '../plan-tree-walk.ts';
import { planShowsSkewSplit } from '../aqe-skew.ts';
import { IDEAL_BYTES_PER_PARTITION_TASK } from '../impact-model.ts';
import { codeFix, decreaseConf, increaseConf, setConf } from '../remediation.ts';
import type { PlanNode } from '../types.ts';
import type { Remediation, StageReads, ShufflePartitions } from '../finding-types.ts';
import { effectiveConf, loggedAs, stageApp } from './conf.ts';
import type { DetectorApp, DetectorCtx, DetectorStage } from './types.ts';

// What a stage reads, by the dominant side: a stage that reads a shuffle and mostly input files is
// an input stage for any fix that sizes a shuffle's reduce side.
export function stageReads(stage: Pick<DetectorStage, 'shuffleReadBytes' | 'inputBytes'>): StageReads {
  if (stage.shuffleReadBytes > 0 && stage.shuffleReadBytes >= stage.inputBytes) return 'shuffle';
  return stage.inputBytes > 0 ? 'input' : 'other';
}

// The run's effective spark.sql.shuffle.partitions (logged, else Spark's 200) as a count, or null
// when the logged value is not a count.
function effectiveShufflePartitions(app: DetectorApp | null): number | null {
  const value = effectiveConf(app, 'spark.sql.shuffle.partitions');
  return value != null && /^\d+$/.test(value) ? Number(value) : null;
}

// The partition count and property that sized a shuffle-reading stage's tasks. AQE only rewrites the
// count of a stage inside a SQL execution. With coalescing on, `initialPartitionNum` replaces
// spark.sql.shuffle.partitions as the starting count when it is set
// (CoalesceShufflePartitions.coalesceShufflePartitions at v3.5.0), so it is the lever then.
const INITIAL_PARTITION_NUM_KEY = 'spark.sql.adaptive.coalescePartitions.initialPartitionNum';

interface PartitionBasis {
  /** The partition count the run's configuration starts the stage from, null when it is not a count. */
  count: number | null;
  /** The property holding it, the one to move to change the stage's partition count. */
  key: string;
  /** Whether AQE can rewrite this stage's task count: it is on and the stage is in a SQL execution. */
  aqe: boolean;
  /** Whether AQE coalescing can merge this stage's partitions. */
  coalesce: boolean;
  /** Whether the execution's final plan shows AQE splitting skewed partitions; null when it cannot say. */
  skewSplit: boolean | null;
  /** Whether the execution's plan holds a `repartition` or `rebalance` the job asked for. */
  explicitRepartition: boolean;
  /** Whether an AQE shuffle read sits over the exchange the stage reads; null when the plan shows none read. */
  shuffleResized: boolean | null;
}

function partitionBasis(stage: DetectorStage, ctx: DetectorCtx): PartitionBasis {
  const app = stageApp(ctx, stage);
  const aqe = stage.sqlExecutionId != null && loggedAs(app, 'spark.sql.adaptive.enabled', true);
  const coalesce = aqe && loggedAs(app, 'spark.sql.adaptive.coalescePartitions.enabled', true);
  const initial = coalesce ? effectiveConf(app, INITIAL_PARTITION_NUM_KEY) : undefined;
  const plan = stage.sqlExecutionId != null ? ctx.sql.get(stage.sqlExecutionId)?.planTree : null;
  const skewSplit = aqe ? planShowsSkewSplit(plan) : null;
  const explicitRepartition = planHasExplicitRepartition(plan);
  const shuffleResized = aqe ? stageShuffleResized(plan, stage.id) : null;
  if (initial != null && /^\d+$/.test(initial)) return { count: Number(initial), key: INITIAL_PARTITION_NUM_KEY, aqe, coalesce, skewSplit, explicitRepartition, shuffleResized };
  return { count: effectiveShufflePartitions(app), key: 'spark.sql.shuffle.partitions', aqe, coalesce, skewSplit, explicitRepartition, shuffleResized };
}

const SHUFFLE_READ_NODE = /^(AQEShuffleRead|CustomShuffleReader)$/;

// Whether AQE resized the shuffle a stage reads: true when an AQE read (coalesced, skewed or local)
// sits over an exchange the stage reads, false when it reads exchanges and none has one (a
// `repartition(n)` exchange never does), null when the plan shows it reading none. An exchange lists its producing
// and its reading stage, and the reader is the later one.
function stageShuffleResized(plan: PlanNode | null | undefined, stageId: number): boolean | null {
  let reads = 0;
  let resized = false;
  const visit = (node: PlanNode, covered: boolean): void => {
    const isExchange = /Exchange$/.test(node.name);
    if (node.exchangeRole === 'read' && node.stageIds?.includes(stageId) && Math.min(...node.stageIds) !== stageId) {
      reads++;
      resized ||= covered;
    }
    const over = !isExchange && (covered || SHUFFLE_READ_NODE.test(node.name));
    for (const child of node.children ?? []) visit(child, over);
  };
  if (plan) visit(plan, false);
  return reads === 0 ? null : resized;
}

// Whether a plan holds an exchange the job asked for (`repartition(n)`, `repartition(col)` or a
// rebalance hint), which is what makes a task count different from the configured one the stage's own.
function planHasExplicitRepartition(plan: PlanNode | null | undefined): boolean {
  let found = false;
  walkPlanTree(plan, (node) => { if (/\b(REPARTITION_BY_NUM|REPARTITION_BY_COL|REBALANCE_PARTITIONS_BY_NONE|REBALANCE_PARTITIONS_BY_COL)\b/.test(node.detail ?? '')) found = true; });
  return found;
}

// How the stage's task count relates to the configured one. 'matches': the configured count sized it
// (or the count is unknown). 'coalesced': AQE merged the partitions into fewer tasks, unless the plan
// shows the stage's exchange with no AQE read over it. 'adjusted': more tasks than configured under
// AQE, which a skew-join split can produce, unless the plan shows the stage's exchange with no AQE
// read over it. Where the plan does not show the stage's exchange, several shuffle reads in one
// execution can obscure the cause: the stage's own repartition(n) is blamed only when the plan holds one.
// 'own': a different count with no AQE to rewrite it, or with a repartition(n) in the plan, which is
// a repartition(n) or an RDD operation that fixed its own count.
type CountRelation = 'matches' | 'coalesced' | 'adjusted' | 'own';

function countRelation(stage: DetectorStage, basis: PartitionBasis): CountRelation {
  if (basis.count == null || stage.taskCount === basis.count) return 'matches';
  if (basis.coalesce && stage.taskCount < basis.count && basis.shuffleResized !== false) return 'coalesced';
  if (basis.aqe && stage.taskCount > basis.count && (basis.shuffleResized ?? (basis.skewSplit !== false || !basis.explicitRepartition))) return 'adjusted';
  return 'own';
}

// Whether partition-count advice fits a shuffle-reading stage. The count that brings each shuffle
// partition to the ideal size is per stage; the property is job-wide. 'sufficient': the tasks are
// already at or under the ideal size. 'aqeCoalesced' and 'ownPartitioning' follow countRelation
// ('ownPartitioning' also when the plan shows an uncoalesced exchange, or the property already gives
// at least the count needed). Otherwise the property limits the stage: 'raise'.
export function shufflePartitionCase(stage: DetectorStage, ctx: DetectorCtx): { partitions: ShufflePartitions; count: number | null; key: string; needed: number } {
  const basis = partitionBasis(stage, ctx);
  const { count, key } = basis;
  const needed = Math.ceil(stage.shuffleReadBytes / IDEAL_BYTES_PER_PARTITION_TASK);
  const tasks = Math.max(1, stage.taskCount);
  const relation = countRelation(stage, basis);
  let partitions: ShufflePartitions = 'raise';
  if (stage.shuffleReadBytes / tasks <= IDEAL_BYTES_PER_PARTITION_TASK) partitions = 'sufficient';
  else if (relation === 'coalesced') partitions = 'aqeCoalesced';
  else if (relation === 'own' && basis.shuffleResized === false) partitions = 'ownPartitioning';
  else if (count != null && count >= needed && relation !== 'adjusted') partitions = 'ownPartitioning';
  return { partitions, count, key, needed };
}

export const ADVISORY_PARTITION_SIZE_KEY = 'spark.sql.adaptive.advisoryPartitionSizeInBytes';
const PARALLELISM_FIRST_KEY = 'spark.sql.adaptive.coalescePartitions.parallelismFirst';

// What sized a shuffle-reading stage's tasks, for advice that moves the partition count: the
// countRelation outcomes as levers ('matches' is 'property'; 'adjusted' is 'aqeAdjusted', where the
// advice stays on the property). Under 'aqeCoalesced' the property does not set the count: AQE
// sizes the merged tasks from the advisory size and, with parallelismFirst (Spark's default), from
// defaultParallelism too (ShufflePartitionsUtil.coalescePartitions and CoalesceShufflePartitions
// at v3.5.0).
type PartitionLever = 'property' | 'aqeCoalesced' | 'aqeAdjusted' | 'ownPartitioning';

export function partitionLever(stage: DetectorStage, ctx: DetectorCtx): { lever: PartitionLever; count: number | null; key: string; explicitRepartition: boolean } {
  const basis = partitionBasis(stage, ctx);
  const relation = countRelation(stage, basis);
  const lever: PartitionLever = relation === 'matches' ? 'property'
    : relation === 'coalesced' ? 'aqeCoalesced'
    : relation === 'adjusted' ? 'aqeAdjusted' : 'ownPartitioning';
  return { lever, count: basis.count, key: basis.key, explicitRepartition: basis.explicitRepartition };
}

// What follows advice on the property when the stage ran more tasks than configured under AQE.
export function aqeAdjustedNote(stage: DetectorStage, count: number | null, explicitRepartition: boolean): string {
  return explicitRepartition
    ? ` (this stage ran ${stage.taskCount} tasks against ${count} configured, and AQE skew-join splits add tasks, so that is not necessarily its own repartition(n))`
    : ` (this stage ran ${stage.taskCount} tasks against ${count} configured, and the plan shows no repartition behind the difference)`;
}

// Whether parallelismFirst is on for the run: logged, else Spark's default from 3.2.0, where it
// exists. A log that records no Spark version is read as current.
export function parallelismFirstOn(app: DetectorApp | null): boolean {
  const effective = effectiveConf(app, PARALLELISM_FIRST_KEY);
  if (effective != null) return effective.toLowerCase() === 'true';
  const version = /^(\d+)\.(\d+)/.exec(app?.sparkVersion ?? '');
  return version == null || Number(version[1]) > 3 || Number(version[2]) >= 2;
}

// The conf that makes AQE's merged tasks larger. With parallelismFirst on, AQE targets
// min(total / defaultParallelism, advisory size), so the advisory size alone merges nothing for
// small tasks: turn parallelismFirst off first. With it off, the advisory size is the lever.
function aqeCoalesceLargerFix(app: DetectorApp | null): { keys: string; remediation: Remediation[] } {
  return parallelismFirstOn(app)
    ? { keys: `setting ${PARALLELISM_FIRST_KEY}=false (so AQE targets the advisory size, not defaultParallelism tasks) and then raising ${ADVISORY_PARTITION_SIZE_KEY}`, remediation: [setConf(PARALLELISM_FIRST_KEY, false), increaseConf(ADVISORY_PARTITION_SIZE_KEY)] }
    : { keys: `raising ${ADVISORY_PARTITION_SIZE_KEY}`, remediation: [increaseConf(ADVISORY_PARTITION_SIZE_KEY)] };
}

// lowShuffleParallelism's fix. Unlike the shuffle finding it fires on stages whose tasks are larger
// than the ideal size, so its cases are 'raise', 'aqeCoalesced' and 'ownPartitioning'.
export function lowShuffleParallelismFix(stage: DetectorStage, ctx: DetectorCtx): { partitions: ShufflePartitions; text: string; remediation: Remediation[] } {
  const { partitions, count, key, needed } = shufflePartitionCase(stage, ctx);
  if (partitions === 'aqeCoalesced') {
    return {
      partitions,
      text: `AQE coalesced the shuffle into ${stage.taskCount} tasks (from ${count} configured partitions): lower ${ADVISORY_PARTITION_SIZE_KEY} so each partition is smaller`,
      remediation: [decreaseConf(ADVISORY_PARTITION_SIZE_KEY)],
    };
  }
  if (partitions === 'ownPartitioning') {
    return {
      partitions,
      text: `${key} (${count}) did not size this stage's ${stage.taskCount} tasks, so raise its own partition count (its repartition(n) or RDD parallelism) so each partition is smaller`,
      remediation: [],
    };
  }
  return {
    partitions,
    text: `raise ${key} so each partition is smaller`,
    remediation: [increaseConf(key, count == null ? null : needed)],
  };
}

// tinyTask's fix on a stage that reads a shuffle: fewer, larger tasks, through whatever sized this
// stage. Lowering spark.sql.shuffle.partitions merges nothing AQE kept for parallelism, and does
// not touch a repartition(n).
export function tinyShuffleFix(stage: DetectorStage, ctx: DetectorCtx, coalesceTo: number): { text: string; remediation: Remediation[] } {
  const { lever, count, key, explicitRepartition } = partitionLever(stage, ctx);
  if (lever === 'aqeCoalesced') {
    const larger = aqeCoalesceLargerFix(stageApp(ctx, stage));
    return {
      text: `${larger.keys}, or using .coalesce(${coalesceTo}): AQE already coalesced the ${count} configured shuffle partitions into ${stage.taskCount} tasks, so lowering the shuffle partition count will not merge them`,
      remediation: larger.remediation,
    };
  }
  if (lever === 'ownPartitioning') {
    const hint = `lowering the repartition(n) or RDD partition count that sized this stage, or using .coalesce(${coalesceTo})`;
    return { text: `${hint} (the configured shuffle partition count is ${count} but this stage ran ${stage.taskCount} tasks)`, remediation: [codeFix(hint)] };
  }
  const note = lever === 'aqeAdjusted' ? aqeAdjustedNote(stage, count, explicitRepartition) : '';
  return { text: `lowering ${key} or using .coalesce(${coalesceTo})${note}`, remediation: [decreaseConf(key)] };
}

// stageSlowness's fix on a stage that reads a shuffle: more tasks. spark.default.parallelism sizes
// RDD shuffles only (the DataFrame shuffle reads spark.sql.shuffle.partitions), so it is not offered.
export function slowShuffleFix(stage: DetectorStage, ctx: DetectorCtx): { text: string; remediation: Remediation[] } {
  const { lever, count, key, explicitRepartition } = partitionLever(stage, ctx);
  if (lever === 'aqeCoalesced') {
    return {
      text: `AQE coalesced the ${count} configured shuffle partitions into ${stage.taskCount} tasks, so lower ${ADVISORY_PARTITION_SIZE_KEY} to get more of them`,
      remediation: [decreaseConf(ADVISORY_PARTITION_SIZE_KEY)],
    };
  }
  if (lever === 'ownPartitioning') {
    const hint = "raise this stage's own partition count (its repartition(n) or RDD parallelism)";
    return { text: `the configured shuffle partition count is ${count} but this stage ran ${stage.taskCount} tasks, so ${hint}`, remediation: [codeFix(hint)] };
  }
  const note = lever === 'aqeAdjusted' ? aqeAdjustedNote(stage, count, explicitRepartition) : '';
  return { text: `raise ${key}${note}`, remediation: [increaseConf(key)] };
}
