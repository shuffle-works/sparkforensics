export type StageId = number;
export type ImpactBand = 'critical' | 'warning' | 'info';

export interface SparkAppInfo {
  name?: string;
  id?: string;
  // startApplication (event-handlers.ts) sets this to `null` explicitly
  // (unknown Spark version until SparkListenerLogStart/ApplicationStart
  // supplies one), not just `undefined`.
  sparkVersion?: string | null;
  config?: Record<string, string>;
  resources?: Record<string, unknown>;
  evidenceInputs?: EvidenceInputs;
  startTime?: number;
  // startApplication seeds this to `null` (app still running); the
  // ApplicationEnd handler later overwrites it with a real number.
  endTime?: number | null;
  [key: string]: unknown;
}

export interface EvidenceInputs {
  environmentUpdates: number;
  applicationEnds: number;
  stageSubmissions: number;
  rddStorageSnapshots: number;
  sqlExecutions: number;
  resolvedSqlPlans: number;
  executorMetricRows: number;
  taskRecords: number;
}

export type EvidenceKey =
  | 'executorMetrics' | 'rddStorageSnapshots' | 'sqlPlan' | 'sparkConfiguration'
  | 'taskCoreTime' | 'infrastructureContext' | 'sourceContext' | 'costContext';
export type EvidenceState = 'present' | 'disabled' | 'notEmitted' | 'notApplicable' | 'outsideEventLog' | 'unknown';
export type EvidenceReasonCode =
  | 'observed' | 'explicitlyDisabled' | 'noObservedExecutorMetrics' | 'noObservedStageSubmission'
  | 'noRddStorageSnapshot'
  | 'noResolvedSqlPlan' | 'noSqlExecution' | 'noEnvironmentUpdate' | 'noTaskRecords'
  | 'noUsableCoreTimeAggregate' | 'outsideEventLogScope' | 'parseIncomplete';
// Contract-pinned evidence `eventType`: the same fixed set as the parser's
// `evidenceInputs` counter keys, so provenance stays addressable against the
// documented `{ eventType, count }` shape (review: values must not diverge
// from the counters they summarize).
export type EvidenceEventType =
  | 'environmentUpdates' | 'applicationEnds' | 'stageSubmissions' | 'rddStorageSnapshots'
  | 'sqlExecutions' | 'resolvedSqlPlans' | 'executorMetricRows' | 'taskRecords';
export interface EvidenceAvailabilityEntry {
  key: EvidenceKey;
  state: EvidenceState;
  reasonCode: EvidenceReasonCode;
  summary: string;
  evidence?: { eventType: EvidenceEventType; count: number };
}
export interface EvidenceAvailability { schemaVersion: 1; entries: EvidenceAvailabilityEntry[]; }

export interface Stage {
  id: StageId;
  name?: string;
  stageType?: string;
  sqlExecutionId?: number | null;
  planTree?: PlanNode | null;
  submittedAt?: number;
  completedAt?: number;
  parentIds?: number[];
  taskCount?: number;
  failedTasks?: number;
  inputBytes?: number;
  outputBytes?: number;
  shuffleReadBytes?: number;
  shuffleReadMax?: number;
  shuffleReadP50?: number;
  shuffleWriteBytes?: number;
  fetchWaitTime?: number;
  memoryBytesSpilled?: number;
  diskBytesSpilled?: number;
  spillClassification?: 'skew' | 'volume' | 'unclassified';
  jvmGCTime?: number;
  executorRunTime?: number;
  gcPct?: number;
  taskDurationP50?: number;
  taskDurationP95?: number;
  taskDurationMax?: number;
  peakExecutionMemoryMax?: number;
  // Wall-clock ms during which at least one of the stage's tasks ran (finalizeStage's
  // computeTaskActiveMs); absent on stages from before this field existed.
  taskActiveMs?: number;
  // Summed (duration - P50) over the tasks slower than 4x P50 (finalizeStage), core-ms.
  stragglerExcessMs?: number;
  // Longest task at or under 4x P50, the longest a straggler fix leaves (finalizeStage).
  longestNonStragglerMs?: number;
  // Most of the stage's tasks running at once (finalizeStage's computePeakConcurrentTasks).
  peakConcurrentTasks?: number;
  localityStats?: { locality: string; count: number }[];
  details?: string;
  [key: string]: unknown;
}

export interface PlanNode {
  // Optional, not the design spec's literal `id: string`: dozens of existing
  // test fixtures hand-build PlanNode literals without one. resolvePlanTree
  // always sets it in production (enforced by a contract test, not this
  // type); consumers downstream of resolvePlanTree use `!` with a comment.
  id?: string;
  name: string;
  detail?: string;
  metrics?: { name: string; value: number; metricType?: string }[];
  children: PlanNode[];
  stageIds?: number[];
  // Present only on the two synthesized halves of a split Exchange/
  // BroadcastExchange node (see resolvePlanTree). Absent on every other
  // node, including ReusedExchange (never split).
  exchangeRole?: 'read' | 'write';
}

export interface SqlExecution {
  id: number;
  planTree?: PlanNode | null;
  [key: string]: unknown;
}
export interface PlanGraphNodeData {
  id: string;
  sourceNodeId: string;
  label: string;
  category: string;
  operatorDetail: string;
  primaryMetric: string;
  segmentIndex: number;
  splitRole: 'read' | 'write' | null;
  /** Wall-time share in ms attributed to this node, or null when no
   * duration data is available (never 0 as a stand-in for "unknown").
   * Reflects whichever `PlanGraphDurationMode` was requested when this
   * model was built (see `exclusiveDurationShare` below for the
   * mode-invariant counterpart). */
  durationShare: number | null;
  /** This node's EXCLUSIVE wall-time share in ms, regardless of which mode
   * `durationShare` above reflects. Exclusive shares are a true,
   * non-overlapping partition of each stage's wall time (see
   * `computeExclusiveSharesForPairs` in plan-duration-attribution.ts), so
   * summing this field across a set of nodes is a stable total even under
   * 'inclusive' mode, where `durationShare` deliberately double/triple-
   * counts a node's own time into every ancestor. Consumers computing a
   * percentage denominator (PlanGraphCanvas) must sum this field, not
   * `durationShare`, or the total inflates non-uniformly by tree depth and
   * distorts every node's percentage. Optional so hand-built fixtures that
   * only need one duration value don't have to duplicate it. */
  exclusiveDurationShare?: number | null;
  /** Plan Advisor findings whose planNodeIds include this node. Empty array
   * (never undefined) when none: Task 10 always sets it. */
  findings?: Finding[];
  /** Every metric Spark reported for this operator, already formatted for
   * display (rows/bytes/timing via `formatPlanMetricValue`). The node box
   * shows only `primaryMetric`; the detail card lists this whole set.
   * Optional so hand-built fixtures don't have to supply it. */
  metrics?: { name: string; value: string }[];
  /** The operator's full, untruncated plan text (`PlanNode.detail`), for the
   * detail card. `operatorDetail` above is a condensed one-liner for the node
   * box; this is the complete simpleString. Optional (empty/absent when the
   * detail just repeats the operator name). */
  detailText?: string;
  /** For a split Exchange half, the `id` of its paired half (a read half
   * points at its write half and vice versa); null/absent on every non-split
   * node. Both halves of one Exchange are always in different segments (the
   * write half opens the producer segment, the read half stays in the
   * consumer segment), so this is the only way to reach the partner from a
   * single-segment view. Computed over the full tree before segment filtering,
   * so it is set even when the partner is scoped out of the current model. */
  pairedNodeId?: string | null;
  /** Bytes crossing this Exchange's shuffle boundary (the producing stage's
   * `shuffleWriteBytes`), mirrored onto BOTH halves of the pair so the detail
   * card can show the volume whichever half is open. Same source as the
   * pairing edge's `shuffleBytes`, but carried on the node so it survives
   * segment filtering (which can drop the pairing edge). Null/absent on
   * non-split nodes and on a zero-byte exchange (e.g. a BroadcastExchange). */
  exchangeShuffleBytes?: number | null;
}

export interface PlanGraphEdge {
  id: string;
  source: string;
  target: string;
  /** Bytes crossing this exchange, set only on a read->write pairing edge (the
   * shuffle boundary): the producing stage's shuffleWriteBytes, or its
   * shuffleReadBytes as a fallback. Absent on ordinary parent-child edges and
   * on a zero-byte exchange (e.g. a BroadcastExchange, which moves little by
   * design). The view scales edge thickness by this and labels it. */
  shuffleBytes?: number;
}

export interface PlanGraphModel {
  nodes: PlanGraphNodeData[];
  edges: PlanGraphEdge[];
  /** Stable component identity for the segment being shown, or null when
   * scope is 'full' (including a 'segment' request that fell back to 'full':
   * see `scope`). Its numeric value does not encode plan depth. */
  segmentIndex: number | null;
  segmentCount: number;
  /** The scope actually rendered: may differ from the requested scope when
   * a 'segment' request falls back to 'full' (no sql linkage, or the
   * segment fell outside the Math.min(segments, stages) truncation). */
  scope: 'segment' | 'full';
  /** Component identity -> stage id for strict stage pairs and display-only
   * nearest-component fallbacks. Computed regardless of `scope`: compound
   * stage-group container headers need this in 'full' scope too, not just to
   * resolve which component a 'segment' request refers to. */
  segmentStageIds: Map<number, number>;
}

export type PlanGraphFilterMode = 'io' | 'basic' | 'advanced';

/** Whether the plan-graph heat bar shows a node's own wall-time share
 * ('exclusive') or that share plus every descendant's, within the same
 * Exchange-bounded segment ('inclusive'). */
export type PlanGraphDurationMode = 'exclusive' | 'inclusive';

export interface Job {
  id: number;
  submissionTime: number | null;
  stageIds: number[];
  sqlExecutionId: number | null;
  result: string | null;
  succeeded: boolean | null;
  exception: unknown;
  completionTime: number | null;
}

export interface ExecutorAddedEvent {
  kind: 'added';
  timestamp: number;
  executorId: string;
  host: string;
  totalCores: number;
  resourceProfileId: number | null;
}
export interface ExecutorRemovedEvent {
  kind: 'removed';
  timestamp: number;
  executorId: string;
  reason: string;
}
export type ExecutorEvent = ExecutorAddedEvent | ExecutorRemovedEvent;
export interface RunAggregates {
  coreHistogram?: unknown;
  busyCoreMs?: number;
  peakConcurrentCores?: number;
  perStage?: Record<string, { totalTaskDurationSum: number; taskCount: number }>;
  [key: string]: unknown;
}

export interface AppModel {
  app: SparkAppInfo | null;
  stages: Map<StageId, Stage>;
  executors: { added: ExecutorAddedEvent[]; removed: ExecutorRemovedEvent[] };
  sql: Map<number, SqlExecution>;
  jobs: Map<number, Job>;
  runAggregates: RunAggregates | null;
  evidenceAvailability: EvidenceAvailability | null;
}

export type ImpactEstimateMethod = 'measured' | 'modeled' | 'none';

export type RawWasteUnit = 'ms' | 'bytes' | 'mbSeconds' | 'coreHours' | 'coreMs';

export interface RawWasteFigure {
  value: number;
  unit: RawWasteUnit;
}

export type ImpactEstimateBasis = 'serial' | 'contended' | 'resourceOnly' | 'informational';

/** Static, hand-authored tag for how much work a finding's fix requires:
 * a conf/spark-submit flag change, a Spark job edit, or a pipeline restructure. */
export type FixEffort = 'config' | 'code' | 'rearchitect';

export interface ImpactEstimate {
  basis: ImpactEstimateBasis;
  /** Milliseconds of wall-clock run time recoverable by fixing the finding, or
   * null when no wall-clock claim is defensible (basis 'resourceOnly' or
   * 'informational'). */
  wallClock: { low: number; high: number } | null;
  estimateMethod: ImpactEstimateMethod;
  rawWaste?: RawWasteFigure;
}

export interface Finding {
  id?: string;
  detectorVersion?: number;
  type: string;
  // Optional (not just nullable): detectors.ts's four `configAudit` entries
  // (scope 'config') and its `duplicatePlanSubtree`/`smallFiles`/
  // `broadcastSizing` entries (scope 'sql') never set a `stageId`: they key
  // findings by `property` or `executionId`/`stageIds` instead. `auditConfig`
  // backfills `null` for config-scope findings before posting, but sql-scope
  // findings reach here with the key genuinely absent.
  stageId?: StageId | null;
  impactBand: ImpactBand;
  metric?: string;
  // Almost always a number (a ratio, byte count, percentage, etc.), but
  // detectors.ts's `stageFailed` entry and its four `configAudit` entries
  // deliberately put human-readable text here (a failure reason, an audited
  // config's current value) instead of a magnitude: there is no separate
  // "text value" field on this shared Finding shape, so those detectors reuse
  // `value` for it.
  value?: number | string;
  recommendation?: string;
  docAnchor?: string;
  confidence?: string;
  validationRequired?: string;
  impactEstimate?: ImpactEstimate;
  property?: string;
  // cachingOpportunity (src/detectors.js)
  relation?: string;
  format?: string;
  executionIds?: number[];
  totalReadBytes?: number;
  relations?: { relation: string; format: string }[];
  operator?: 'join' | 'union';
  // duplicatePlanSubtree/smallFiles/underBroadcast/overBroadcast (src/detectors.js)
  stageIds?: number[];
  // Plan-node origin of this finding, when known: the four Plan Advisor
  // detectors (duplicatePlanSubtree/smallFiles/overBroadcast/underBroadcast)
  // set this. An array, not a single id: duplicatePlanSubtree flags a whole
  // subtree, and the broadcast detectors can involve more than one node.
  planNodeIds?: string[];
  [key: string]: unknown;
}

export interface TaskData { metrics: Float64Array | number[]; fieldNames: string[]; }

export interface PlanGraphSegmentGroupNodeData {
  width: number;
  height: number;
  stageId: number | null;
  /** Pre-formatted via `formatDuration` (src/format-utils.js) by the caller;
   * null (never 0) when this segment has no attributed duration, e.g. it
   * fell outside attributeStageDurationToPlan's Math.min(segments, stages)
   * truncation. */
  durationLabel: string | null;
  /** Every finding on this stage, in full (not just the worst impact band). */
  findings: Finding[];
}

export interface PlanGraphStageGroupNodeData {
  width: number;
  height: number;
  stageId: number;
  findings: Finding[];
  /** True when no segment box is zipped to this stage id, so this box has
   * to paint its own findings chips instead of leaving that to the segment
   * box's header row (see PlanGraphCanvas.tsx's focal-stage fallback).
   * Defaults to shown when omitted. */
  showOwnFindings?: boolean;
  onSelect?: () => void;
}
