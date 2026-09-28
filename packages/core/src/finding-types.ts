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
  docAnchor?: string;
  confidence?: string;
  validationRequired?: string;
  impactEstimate?: ImpactEstimate;
}

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

// ── Per-stage detectors ─────────────────────────────────────────────────────

export type SkewEvidence = Record<never, never>;
export interface SkewFinding extends NumericFinding<'skew'>, SkewEvidence {}

export interface StageShapeEvidence {
  rule: 'lowParallelism' | 'dataExplosion' | 'taskStageSkew';
}
export interface StageShapeFinding extends NumericFinding<'stageShape'>, StageShapeEvidence {
  // Absolute core count behind pRatio/taskStageSkew, for the impact estimator's idle-core-ms figure.
  totalCores?: number;
}

export type ShuffleEvidence = Record<never, never>;
export interface ShuffleFinding extends NumericFinding<'shuffle'>, ShuffleEvidence {}

export interface PartitionSizingEvidence {
  rule: 'shufflePartitionSkew' | 'lowShuffleParallelism' | 'maxPartitionTooBig';
}
export interface PartitionSizingFinding extends NumericFinding<'partitionSizing'>, PartitionSizingEvidence {}

export interface SpillEvidence {
  spillMagnitude?: 'severe' | 'high' | 'medium';
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
}
export interface SlowHostFinding extends NumericFinding<'slowHost'>, SlowHostEvidence {}

export type StageSlownessEvidence = Record<never, never>;
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
  unit: 'count' | 'pct';
  speculativeTasks: number;
  stragglerCount: number;
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

export type TinyTaskEvidence = Record<never, never>;
export interface TinyTaskFinding extends NumericFinding<'tinyTask'>, TinyTaskEvidence {}

// ── App-level detectors ─────────────────────────────────────────────────────

export type IncompleteRunEvidence = Record<never, never>;
// valueText is always 'missing': the ApplicationEnd event the log lacks.
export interface IncompleteRunFinding extends TextFinding<'incompleteRun'>, IncompleteRunEvidence {}

export type ColdStartEvidence = Record<never, never>;
export interface ColdStartFinding extends NumericFinding<'coldStart'>, ColdStartEvidence {}

export interface UtilizationEvidence {
  // CPU-time share of capacity (sparkMeasure's measure), a companion to the busy-time `value`.
  cpuUtilizationPct: number | null;
}
export interface UtilizationFinding extends NumericFinding<'utilization'>, UtilizationEvidence {
  // Impact-estimator inputs: the unrounded `value`, and the run's span and peak cores it was
  // measured against.
  utilizationFraction: number;
  appDurationMs: number;
  totalCores: number;
}

export interface MemoryUtilizationEvidence {
  variant: 'idleCores' | 'memoryBand' | 'wasteModel';
  // memoryBand only: which band a measured executor fell in.
  rule?: 'heapNearCapacity' | 'heapOverProvisioned';
  executorId?: string;
  // heapOverProvisioned only: the executor's peak heap, bytes.
  heap?: number;
  // The memoryBand caveat for a log with no executor metrics.
  dataUnavailable?: boolean;
}
export interface MemoryUtilizationFinding extends NumericFinding<'memoryUtilization'>, MemoryUtilizationEvidence {
  // Impact-estimator inputs: the unrounded idle rate and the run's sizing (idleCores), and the
  // allocation and span behind heapOverProvisioned's rounded ratio.
  idleRateFraction?: number;
  allocatedMB?: number | null;
  peakExecutors?: number;
  appDurationMs?: number;
  allocatedBytes?: number;
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

// ── Config-scope detectors ──────────────────────────────────────────────────

export interface ConfigAuditEvidence {
  property: string;
}
// valueText is the audited property's current value, or a note that it is unset or inverted.
export interface ConfigAuditFinding extends TextFinding<'configAudit'>, ConfigAuditEvidence {}

// ── SQL-scope (Plan Advisor) detectors ──────────────────────────────────────

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

export interface UnderBroadcastEvidence extends PlanFindingEvidence {
  largerSideBytes: number;
}
export interface UnderBroadcastFinding extends NumericFinding<'underBroadcast'>, UnderBroadcastEvidence, PlanNodeOrigin {}

export type OverBroadcastEvidence = PlanFindingEvidence;
export interface OverBroadcastFinding extends NumericFinding<'overBroadcast'>, OverBroadcastEvidence, PlanNodeOrigin {}

// ── Unions ──────────────────────────────────────────────────────────────────

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
  memoryUtilization: MemoryUtilizationEvidence;
  cacheUtilization: CacheUtilizationEvidence;
  coreLocality: CoreLocalityEvidence;
  autoscalingChurn: AutoscalingChurnEvidence;
  cachingOpportunity: CachingOpportunityEvidence;
  jobFailureRate: JobFailureRateEvidence;
  configAudit: ConfigAuditEvidence;
  duplicatePlanSubtree: DuplicatePlanSubtreeEvidence;
  smallFiles: SmallFilesEvidence;
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
  | MemoryUtilizationFinding
  | CacheUtilizationFinding
  | CoreLocalityFinding
  | AutoscalingChurnFinding
  | CachingOpportunityFinding
  | JobFailureRateFinding
  | ConfigAuditFinding
  | DuplicatePlanSubtreeFinding
  | SmallFilesFinding
  | UnderBroadcastFinding
  | OverBroadcastFinding;

/** The finding member for one `type`. */
export type FindingOf<T extends Finding['type']> = Extract<Finding, { type: T }>;
