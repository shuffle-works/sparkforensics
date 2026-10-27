// Per-detector finding shapes. `Finding` is a union discriminated on `type`, one member per
// emitted finding type; `FindingType` (detectors.ts) derives the same set from `DETECTORS`' `emits`
// lists, and a compile-time check there keeps the two equal.
//
// Each member is split in two: `<Type>Evidence` is the public part, the fields the evidence report
// publishes as a finding row's `evidence` (EVIDENCE_KEYS in evidence-report.ts must list every one of
// them), and anything declared only on `<Type>Finding` is internal, read by another core module (the
// impact estimator, mostly) and never published. Renaming or removing an evidence field is a
// breaking change to the report and needs an EVIDENCE_SCHEMA_VERSION bump.
import type { ImpactBand, ImpactEstimate, StageId } from './types.ts';
import type { TaskFailureGroup } from './task-failure.ts';

/** One concrete change a finding's fix makes, alongside its prose `recommendation`. Entries are
 * applied together unless the recommendation words them as alternatives ("either ... or"), as an
 * idle-capacity finding does with dynamic allocation off: then a consumer applies one. */
export type Remediation = ConfRemediation | CodeRemediation;

/** A Spark property the detector already names; `suggested` is null when it computes no value.
 * Sizes carry a Spark unit suffix ("384m"), counts are plain numbers, switches are booleans. */
export interface ConfRemediation {
  kind: 'conf';
  key: string;
  direction: 'increase' | 'decrease' | 'set';
  suggested: number | string | boolean | null;
}

/** A fix no Spark property makes: the job's code or data has to change. `hint` is the same
 * wording the finding's `recommendation` gives. */
export interface CodeRemediation {
  kind: 'code';
  hint: string;
}

// The columns every finding carries, whatever its detector.
interface FindingCore<T extends string> {
  id?: string;
  detectorVersion?: number;
  type: T;
  // Optional (not just nullable): config-scope findings key on `property` and sql-scope findings
  // on `executionId`/`stageIds`, never setting a `stageId`. `auditConfig` backfills `null` for
  // config-scope findings, but sql-scope findings reach consumers with the key absent.
  stageId?: StageId | null;
  impactBand: ImpactBand;
  metric?: string;
  recommendation?: string;
  // Structured form of the property changes `recommendation` names; absent when it names none.
  remediation?: Remediation[];
  docAnchor?: string;
  confidence?: string;
  validationRequired?: string;
  impactEstimate?: ImpactEstimate;
  // Set only when the CLI or MCP server ran this finding's detector with a user override that
  // differs from the specification default: each overridden threshold, keyed by name.
  tunedThresholds?: TunedThresholds;
}

/** One overridden threshold: the value the detector ran with, and its specification default. */
export interface TunedThreshold {
  value: number | readonly number[];
  default: number | readonly number[];
}

export type TunedThresholds = Readonly<Record<string, TunedThreshold>>;

// A finding whose `value` is a magnitude (a ratio, byte count, percentage, duration...). Absent on
// an evidence caveat, which has nothing to measure.
interface NumericFinding<T extends string> extends FindingCore<T> {
  value?: number;
  valueText?: undefined;
}

// A finding whose observed value is display text (a failure reason, an audited config's current
// value), carried in `valueText` so `value` stays numeric across every finding.
interface TextFinding<T extends string> extends FindingCore<T> {
  value?: undefined;
  valueText: string;
}

// A failed or retried task attempt, as a stage keeps a bounded sample of them.
export interface TaskAttemptSample {
  taskId: number | null;
  attemptNumber: number;
  host: string;
  executorId: string;
  reason: string | null;
  peakExecMem: number;
  memSpilled: number;
  shuffleWrite: number;
}

/** What a skewed stage reads, which decides the fix: 'shuffleJoin' (a shuffle feeding a join, where
 * AQE skew-join handling applies), 'inputScan' (uneven input files) or 'other'. */
export type SkewOrigin = 'shuffleJoin' | 'inputScan' | 'other';

/** What AQE skew-join handling did for a 'shuffleJoin' stage, read from the final plan and the
 * effective conf: 'split' (it split the skewed partition, so the rest is not join skew),
 * 'evenReads' (the shuffle reads are even, so no partition is skewed for AQE to split),
 * 'belowThreshold' (the partition is under the effective skew threshold or factor), 'planShape' (an
 * operator sits between the join and its shuffle), 'userRepartition' (the shuffle is an explicit
 * repartition), 'joinType' (the join type does not let AQE split the skewed side),
 * 'extraShuffle' (splitting would add a shuffle for the operator above the join) or 'notSplit'
 * (nothing in the log explains it). */
export type AqeSkewCase = 'split' | 'evenReads' | 'belowThreshold' | 'planShape' | 'userRepartition' | 'joinType' | 'extraShuffle' | 'notSplit';

/** What a stage reads, by the dominant side: a shuffle, input files, or neither. */
export type StageReads = 'shuffle' | 'input' | 'other';

/** Why a shuffle finding's partition-count advice is or is not given: 'raise' (the property limits
 * the stage), 'sufficient' (tasks are already a good size), 'aqeCoalesced' (AQE merged the
 * partitions, so the advisory size is the lever) or 'ownPartitioning' (the property did not size
 * the stage, so the stage's own repartition(n) or RDD parallelism is the lever). */
export type ShufflePartitions = 'raise' | 'sufficient' | 'aqeCoalesced' | 'ownPartitioning';

/** Why a stage's slow tail is slow (attributeTail in stage-quantiles.ts). 'data': the slow tasks
 * read far more than the median task, so run time follows data volume. 'gc', 'fetchWait' and
 * 'host': the tail's extra time is GC, shuffle fetch wait, or tasks piled on one host.
 * 'unexplained': the slow tasks read no more than the median and none of those accounts for their
 * time. 'unattributed': the stage has no data volume to compare and what data, GC, fetch wait and
 * host do not explain is the largest share (or the stage has no tail attribution), so only the
 * duration is known. */
export type TailCause = 'data' | 'gc' | 'fetchWait' | 'host' | 'unexplained' | 'unattributed';

export interface SkewEvidence {
  origin?: SkewOrigin;
  // Only on origin 'shuffleJoin' with AQE skew-join handling on and the join resolved from the plan.
  aqeSkew?: AqeSkewCase;
  // Always 'data'; a stage whose tail is not data, or has no measured cause, does not get a skew finding.
  cause?: TailCause;
  // Median over the slow tasks of how many times the median task's data each read.
  dataRatio?: number;
}
export interface SkewFinding extends NumericFinding<'skew'>, SkewEvidence {}

export interface StageShapeEvidence {
  rule: 'lowParallelism' | 'dataExplosion' | 'taskStageSkew';
}
export interface StageShapeFinding extends NumericFinding<'stageShape'>, StageShapeEvidence {
  // Absolute core count behind pRatio/taskStageSkew, for the impact estimator's idle-core-ms figure.
  totalCores?: number;
}

export interface ShuffleEvidence {
  partitions?: ShufflePartitions;
}
export interface ShuffleFinding extends NumericFinding<'shuffle'>, ShuffleEvidence {}

export interface PartitionSizingEvidence {
  rule: 'shufflePartitionSkew' | 'lowShuffleParallelism' | 'maxPartitionTooBig';
  // Only on 'shufflePartitionSkew': see SkewOrigin and AqeSkewCase.
  origin?: SkewOrigin;
  aqeSkew?: AqeSkewCase;
  // Only on 'shufflePartitionSkew': true when the median partition is empty and one partition holds
  // nearly all the stage's shuffle read, so one key carries the shuffle.
  singleKey?: true;
  // Only on 'lowShuffleParallelism': see ShufflePartitions ('raise', 'aqeCoalesced' or 'ownPartitioning').
  partitions?: ShufflePartitions;
}
export interface PartitionSizingFinding extends NumericFinding<'partitionSizing'>, PartitionSizingEvidence {}

/** An operator of the spilling stage with the "spill size" the plan reports for it. A Sort under a
 * SortMergeJoin names it in `feeds`. */
export interface SpillOperator {
  nodeId: string;
  name: string;
  spillBytes: number;
  feeds?: string;
  // The operator's plan arguments (a Sort's keys, an aggregate's keys and functions), cut at a word near 300 characters.
  arguments?: string;
  // Sort only: true for a global sort (ORDER BY), false for one within each partition.
  global?: boolean;
}

/** The columns of an exchange's rows and their estimated bytes per row ("data size" over shuffle
 * records written). Each is absent when unknown. */
export interface ExchangeWidth {
  columns?: number;
  bytesPerRow?: number;
}

/** The width of an exchange an operator reads from, with its read half's plan node id. */
export interface SpillExchange extends ExchangeWidth {
  nodeId: string;
  // The partitioning as the plan prints it (`hashpartitioning(k#1, 200)`) and its partition count.
  partitioning?: string;
  partitions?: number;
  // Why Spark planned the shuffle. REPARTITION_BY_NUM is the job's own repartition(n), so
  // spark.sql.shuffle.partitions does not change its count.
  origin?: string;
}

export interface SpillEvidence {
  spillMagnitude?: 'severe' | 'high' | 'medium';
  // What the stage reads: shuffle-partition advice applies only to 'shuffle'.
  reads?: StageReads;
  // Memory spill over the stage's input plus shuffle read; absent when that input is small.
  spillToInputRatio?: number;
  // Set with the ratio: true from 10x, which means the rows are wide.
  wideRows?: boolean;
  // Up to five operators that report a spill size, largest first.
  operators?: SpillOperator[];
  // The exchanges those operators read.
  exchanges?: SpillExchange[];
  // Description of the SQL execution the stage belongs to, cut at a word near 200 characters.
  sqlDescription?: string;
}
export interface SpillFinding extends NumericFinding<'spill'>, SpillEvidence {}

export interface GcEvidence {
  // Only on the low-GC (over-provisioned memory) branch.
  direction?: 'low';
}
export interface GcFinding extends NumericFinding<'gc'>, GcEvidence {}

// Three shapes share this type: a slow host by mean task time (no variant), a host doing most of the
// stage's task time ('durationShare'), and an executor deviating on one dimension ('multiDim').
export interface SlowHostEvidence {
  variant?: 'durationShare' | 'multiDim';
  host?: string;
  hostTaskShare?: number;
  // The host's mean task duration, ms: `value` is a ratio or share.
  hostMeanMs?: number;
  dimension?: 'taskTime' | 'inputBytes' | 'shuffleBytes' | 'storageMemory';
  executorId?: string;
  // The deviating executor's raw magnitude in `dimension`'s unit (ms for taskTime, else bytes).
  execMaxValue?: number;
  // multiDim taskTime: how many executors the deviating one was picked from, and the stage's task
  // count. The largest of N samples reaches a high ratio by chance more often as N grows.
  executorCount?: number;
  taskCount?: number;
}
export interface SlowHostFinding extends NumericFinding<'slowHost'>, SlowHostEvidence {}

export interface StageSlownessEvidence {
  // What the stage reads, which decides the fix: a shuffle, input files, or neither.
  reads?: StageReads;
}
export interface StageSlownessFinding extends NumericFinding<'stageSlowness'>, StageSlownessEvidence {}

export interface StageFailedEvidence {
  variant: 'stageFailure';
  numTasks: number;
  memoryBytesSpilled: number;
  failedTaskDetails: TaskAttemptSample[];
}
// valueText is the stage's recorded failure reason.
export interface StageFailedFinding extends TextFinding<'stageFailed'>, StageFailedEvidence {}

export interface FailuresEvidence {
  failedTasks: number;
  dominantReason: string | null;
  dominantError: string | null;
  // One entry per distinct error, most frequent first; otherFailedTasks counts the failed tasks
  // no listed group covers.
  failureGroups: TaskFailureGroup[];
  otherFailedTasks: number;
}
export interface FailuresFinding extends NumericFinding<'failures'>, FailuresEvidence {}

export interface StragglerEvidence {
  // 'ratio' when only skew's duration gate admits the tail: value is its ratio, metric its name.
  unit: 'count' | 'pct' | 'ratio';
  speculativeTasks: number;
  stragglerCount: number;
  // The case the skew advice in the recommendation was written for (see SkewOrigin); set only
  // when the cause is 'data'.
  origin?: SkewOrigin;
  aqeSkew?: AqeSkewCase;
  // 'data' only on a tail skew's own gate does not admit: skew reports every other data-driven tail.
  cause?: TailCause;
  // Share (0-100) of the slow tasks' extra time that the cause accounts for.
  causeSharePct?: number;
  // Set when the cause is 'host': the host most of the slow tasks ran on, and how many did.
  host?: string;
  hostTasks?: number;
  // The slow tasks' CPU time as a share (0-100) of their run time, when the log has CPU time.
  cpuPct?: number;
}
export interface StragglerFinding extends NumericFinding<'straggler'>, StragglerEvidence {}

export type SpeculationWasteEvidence = Record<never, never>;
export interface SpeculationWasteFinding extends NumericFinding<'speculationWaste'>, SpeculationWasteEvidence {}

export interface RetryWasteEvidence {
  numTasks: number;
  memoryBytesSpilled: number;
  retriedTaskDetails: TaskAttemptSample[];
}
export interface RetryWasteFinding extends NumericFinding<'retryWaste'>, RetryWasteEvidence {
  // The dashboard's longer explanation of the waste, display copy rather than evidence.
  extended?: string;
}

export interface TinyTaskEvidence {
  // What the stage reads: the shuffle-partition remedy applies only to 'shuffle'.
  reads?: StageReads;
}
export interface TinyTaskFinding extends NumericFinding<'tinyTask'>, TinyTaskEvidence {}

export type IncompleteRunEvidence = Record<never, never>;
// valueText is always 'missing': the ApplicationEnd event the log lacks.
export interface IncompleteRunFinding extends TextFinding<'incompleteRun'>, IncompleteRunEvidence {}

export interface ColdStartEvidence {
  // 'off' when the run's conf turns dynamic allocation off: no executor-count property applies.
  dynamicAllocation?: 'on' | 'off';
}
export interface ColdStartFinding extends NumericFinding<'coldStart'>, ColdStartEvidence {}

export interface UtilizationEvidence {
  // CPU-time share of capacity, a companion to the busy-time `value`.
  cpuUtilizationPct: number | null;
}
export interface UtilizationFinding extends NumericFinding<'utilization'>, UtilizationEvidence {
  // Impact-estimator inputs: the unrounded `value`, the run's span, its peak cores, and the
  // allocated core-milliseconds (cores x time alive) the busy time was measured against.
  utilizationFraction: number;
  appDurationMs: number;
  totalCores: number;
  allocatedCoreMs: number;
}

// `value` is the modeled core count: the smallest whose makespan stays within the detector's
// tolerance of the observed stages-active time (`observedActiveMs`), `modeledActiveMs` at that count.
export interface RightSizingEvidence {
  observedCores: number;
  observedActiveMs: number;
  modeledActiveMs: number;
  // Idealized makespan at `observedCores` against `observedActiveMs`: how far to trust the model.
  modelErrorPct: number;
}
export interface RightSizingFinding extends NumericFinding<'rightSizing'>, RightSizingEvidence {}

export interface MemoryUtilizationEvidence {
  variant: 'idleCores' | 'memoryBand' | 'wasteModel';
  // memoryBand only: the measured band the executors fell in.
  rule?: 'heapOverProvisioned';
  // heapOverProvisioned: the executor with the highest sampled heap peak.
  executorId?: string;
  // heapOverProvisioned only: that peak heap, bytes (a lower bound: Spark samples at heartbeat).
  heap?: number;
  // The memoryBand caveat for a log with no executor metrics.
  dataUnavailable?: boolean;
}
export interface MemoryUtilizationFinding extends NumericFinding<'memoryUtilization'>, MemoryUtilizationEvidence {
  // Impact-estimator inputs: the unrounded idle rate and the run's allocated memory-time
  // (idleCores; wasteModel carries the allocated memory-time too), and the allocation and
  // executor-time behind heapOverProvisioned's rounded ratio.
  idleRateFraction?: number;
  allocatedMBSeconds?: number | null;
  allocatedBytes?: number;
  // heapOverProvisioned: executors with a measured peak, and the seconds the run's executors were alive.
  executorCount?: number;
  executorSeconds?: number;
}

export interface CacheUtilizationEvidence {
  variant: 'partialCache' | 'diskSpillover' | 'storageUnobserved';
  rddId?: number;
  rddName?: string;
  memorySize?: number;
  diskSize?: number;
  numCachedPartitions?: number;
  numPartitions?: number;
  // storageUnobserved: the log has no cache-storage evidence at all.
  dataUnavailable?: boolean;
}
export interface CacheUtilizationFinding extends NumericFinding<'cacheUtilization'>, CacheUtilizationEvidence {}

export interface CoreLocalityEvidence {
  nonLocalTaskCount: number;
}
export interface CoreLocalityFinding extends NumericFinding<'coreLocality'>, CoreLocalityEvidence {}

export interface AutoscalingChurnEvidence {
  shortLivedExecutorCount: number;
  // 'off' when the run's conf turns dynamic allocation off: its properties have no effect.
  dynamicAllocation?: 'on' | 'off';
}
export interface AutoscalingChurnFinding extends NumericFinding<'autoscalingChurn'>, AutoscalingChurnEvidence {}

// A relation scanned by several SQL executions (no variant), or a join/union result several
// executions recompute ('composite', which lists its leaf relations).
export interface CachingOpportunityEvidence {
  variant?: 'composite';
  relation: string;
  format: string;
  relations?: { relation: string; format: string }[];
  operator?: 'join' | 'union';
  executionIds: number[];
  totalReadBytes: number;
}
export interface CachingOpportunityFinding extends NumericFinding<'cachingOpportunity'>, CachingOpportunityEvidence {}

export interface JobFailureRateEvidence {
  failedJobs: number;
  totalJobs: number;
  failedTasks: number;
  totalTasks: number;
  // Mean wall-clock of the failed jobs that recorded both timestamps, ms (0 when none did).
  avgJobDurationMs: number;
  taskFailureRate: number;
}
export interface JobFailureRateFinding extends NumericFinding<'jobFailureRate'>, JobFailureRateEvidence {}

export interface ConfigAuditEvidence {
  property: string;
}
// valueText is the audited property's current value, or a note that it is unset.
export interface ConfigAuditFinding extends TextFinding<'configAudit'>, ConfigAuditEvidence {}

interface PlanFindingEvidence {
  executionId: number;
  stageIds: number[];
}
// View-layer plan-graph node ids the finding came from (plan-graph-model.ts). An array: a
// duplicate subtree spans many nodes, and a broadcast finding can involve more than one.
interface PlanNodeOrigin {
  planNodeIds: string[];
}

export interface DuplicatePlanSubtreeEvidence extends PlanFindingEvidence {
  // Share of each linked stage's operators that sit in the repeated subtree.
  stageShares: Record<number, number>;
  occurrencesIdentical: boolean;
  readsDifferentVersions: boolean;
  rootAction?: string;
  rootName: string;
  subtreeSize: number;
  sampleRelation: string | null;
  groupIndex: number;
}
export interface DuplicatePlanSubtreeFinding
  extends NumericFinding<'duplicatePlanSubtree'>, DuplicatePlanSubtreeEvidence, PlanNodeOrigin {}

export interface SmallFilesEvidence extends PlanFindingEvidence {
  fileCount: number;
  direction: 'read' | 'write';
  nodeName: string;
}
export interface SmallFilesFinding extends NumericFinding<'smallFiles'>, SmallFilesEvidence, PlanNodeOrigin {}

/** A MergeIntoCommand that rewrote far more unmodified target rows than it changed (`rewrittenRows`),
 * or kept most target files after skipping although its changes touched few of the partitions it
 * scanned (`weakSkipping`). `value` is the unmodified rows rewritten, or the files kept. The file and
 * partition counts are null for a rule that does not read them. */
export interface MergeRewriteEvidence extends PlanFindingEvidence {
  rule: 'rewrittenRows' | 'weakSkipping';
  rewrittenRows: number;
  changedRows: number;
  filesBefore: number | null;
  filesAfter: number | null;
  partitionsScanned: number | null;
  partitionsTouched: number | null;
  /** The table or path the MERGE writes, null when the log does not name exactly one. */
  target: string | null;
}
export interface MergeRewriteFinding extends NumericFinding<'mergeRewrite'>, MergeRewriteEvidence, PlanNodeOrigin {}

/** A scan of a partitioned table that filters the rows it reads but has no partition filter, one finding per table in an
 * execution. `value` is the bytes all its flagged scans read. The plan does not name the partition columns, so the finding asks
 * for confirmation. */
export interface UnprunedScanEvidence extends PlanFindingEvidence {
  /** The most partitions one scan read: scans of one table read the same partitions. */
  partitionsRead: number;
  /** The scan's row filters, without the null checks Spark adds. */
  dataFilters: string[];
  /** The scanned table or path, as the Sources list names it. */
  relation: string;
}
export interface UnprunedScanFinding extends NumericFinding<'unprunedScan'>, UnprunedScanEvidence, PlanNodeOrigin {}

export interface PythonUdfEvidence extends PlanFindingEvidence {
  // Bytes the executors sent to Python workers: the finding's `value`, repeated for the report.
  dataSentBytes: number;
  // Bytes the workers returned; null when the plan reports no such metric.
  dataReturnedBytes: number | null;
  // Summed wall-clock of the stages that ran the row-at-a-time UDFs, ms.
  stageDurationMs: number;
}
export interface PythonUdfFinding extends NumericFinding<'pythonUdf'>, PythonUdfEvidence, PlanNodeOrigin {}
/** A BroadcastNestedLoopJoin or CartesianProduct whose output is far larger than both inputs.
 * `nodeName` is the operator, `joinType` the Spark join type (null when the plan line has none)
 * and `condition` the join condition with expression ids removed (null for a join without one).
 * `leftRows` and `rightRows` are the input row counts the executors reported, null for a
 * CartesianProduct, which re-reads its inputs so their counts are not row counts. */
export interface NestedLoopJoinEvidence extends PlanFindingEvidence {
  nodeName: 'BroadcastNestedLoopJoin' | 'CartesianProduct';
  joinType: string | null;
  condition: string | null;
  outputRows: number;
  leftRows: number | null;
  rightRows: number | null;
}
export interface NestedLoopJoinFinding extends NumericFinding<'nestedLoopJoin'>, NestedLoopJoinEvidence, PlanNodeOrigin {}

/** How the effective broadcast threshold (spark.sql.autoBroadcastJoinThreshold, or its adaptive counterpart under AQE) relates to the finding: 'limits' (the
 * property decided it, or is unknown), 'notLimiting' (already admits, or already below, the
 * broadcast, so something else decided it) or 'disabled' (-1). */
export type BroadcastThreshold = 'limits' | 'notLimiting' | 'disabled';

export interface UnderBroadcastEvidence extends PlanFindingEvidence {
  /** The join's other, larger side (`value` is the smaller, build side). */
  largerSideBytes: number;
  /** The join type and the side a broadcast would build from, the smaller of those the type allows. */
  joinType: string;
  buildSide: 'left' | 'right';
  broadcastThreshold?: BroadcastThreshold;
}
export interface UnderBroadcastFinding extends NumericFinding<'underBroadcast'>, UnderBroadcastEvidence, PlanNodeOrigin {}

export interface OverBroadcastEvidence extends PlanFindingEvidence {
  broadcastThreshold?: BroadcastThreshold;
}
export interface OverBroadcastFinding extends NumericFinding<'overBroadcast'>, OverBroadcastEvidence, PlanNodeOrigin {}

/** Public evidence fields per finding type: what a report row's `evidence` carries. */
export interface FindingEvidenceMap {
  skew: SkewEvidence;
  stageShape: StageShapeEvidence;
  shuffle: ShuffleEvidence;
  partitionSizing: PartitionSizingEvidence;
  spill: SpillEvidence;
  gc: GcEvidence;
  slowHost: SlowHostEvidence;
  stageSlowness: StageSlownessEvidence;
  stageFailed: StageFailedEvidence;
  failures: FailuresEvidence;
  straggler: StragglerEvidence;
  speculationWaste: SpeculationWasteEvidence;
  retryWaste: RetryWasteEvidence;
  tinyTask: TinyTaskEvidence;
  incompleteRun: IncompleteRunEvidence;
  coldStart: ColdStartEvidence;
  utilization: UtilizationEvidence;
  rightSizing: RightSizingEvidence;
  memoryUtilization: MemoryUtilizationEvidence;
  cacheUtilization: CacheUtilizationEvidence;
  coreLocality: CoreLocalityEvidence;
  autoscalingChurn: AutoscalingChurnEvidence;
  cachingOpportunity: CachingOpportunityEvidence;
  jobFailureRate: JobFailureRateEvidence;
  configAudit: ConfigAuditEvidence;
  duplicatePlanSubtree: DuplicatePlanSubtreeEvidence;
  smallFiles: SmallFilesEvidence;
  mergeRewrite: MergeRewriteEvidence;
  unprunedScan: UnprunedScanEvidence;
  pythonUdf: PythonUdfEvidence;
  nestedLoopJoin: NestedLoopJoinEvidence;
  underBroadcast: UnderBroadcastEvidence;
  overBroadcast: OverBroadcastEvidence;
}

export type Finding =
  | SkewFinding
  | StageShapeFinding
  | ShuffleFinding
  | PartitionSizingFinding
  | SpillFinding
  | GcFinding
  | SlowHostFinding
  | StageSlownessFinding
  | StageFailedFinding
  | FailuresFinding
  | StragglerFinding
  | SpeculationWasteFinding
  | RetryWasteFinding
  | TinyTaskFinding
  | IncompleteRunFinding
  | ColdStartFinding
  | UtilizationFinding
  | RightSizingFinding
  | MemoryUtilizationFinding
  | CacheUtilizationFinding
  | CoreLocalityFinding
  | AutoscalingChurnFinding
  | CachingOpportunityFinding
  | JobFailureRateFinding
  | ConfigAuditFinding
  | DuplicatePlanSubtreeFinding
  | SmallFilesFinding
  | MergeRewriteFinding
  | UnprunedScanFinding
  | PythonUdfFinding
  | NestedLoopJoinFinding
  | UnderBroadcastFinding
  | OverBroadcastFinding;

/** The finding member for one `type`. */
export type FindingOf<T extends Finding['type']> = Extract<Finding, { type: T }>;
