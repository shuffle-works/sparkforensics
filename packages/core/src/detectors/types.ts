import type { BandPolicy } from '../impact-band.ts';
import type { EstimateCtx } from '../impact-model.ts';
import type { ExecutionsByRoot } from '../delta-targets.ts';
import type {
  ExecutorAddedEvent, ExecutorRemovedEvent, Finding, FixEffort, ImpactEstimate, Job, RddInfo, RunAggregates,
  SparkAppInfo, SqlExecution,
} from '../types.ts';
import type { FinalizedStage, StageExecutorStat, StageFailureReason } from '../stage-quantiles.ts';
import type { FindingOf } from '../finding-types.ts';

// Detector views of the posted model: each is a Pick of the type that builds it, so a renamed or
// never-set field is a compile error here rather than a detector that goes quiet.
export type DetectorExecutorStat = StageExecutorStat;
export type DetectorFailureReason = StageFailureReason;
export type DetectorRddInfo = RddInfo;

export type DetectorStage = Pick<FinalizedStage,
  | 'id' | 'sqlExecutionId' | 'taskCount' | 'failedTasks' | 'inputBytes' | 'outputBytes' | 'submittedAt' | 'completedAt'
  | 'shuffleReadBytes' | 'shuffleReadP50' | 'shuffleReadMax' | 'memoryBytesSpilled' | 'peakExecutionMemoryMax'
  | 'spillClassification' | 'spillDiskMax' | 'spillMemMax' | 'spillDiskP50' | 'spillMemP50'
  | 'gcPct' | 'executorRunTime' | 'executorCpuTime' | 'taskDurationP50' | 'taskDurationP95' | 'taskDurationMax'
  | 'hostStats' | 'executorStats' | 'executorMetrics' | 'failureReasons' | 'failureGroups' | 'retryFailureGroups'
  | 'localityStats' | 'stragglerCount' | 'stragglerExcessMs' | 'longestNonStragglerMs' | 'peakConcurrentTasks'
  | 'tailAttribution' | 'speculativeTasks' | 'speculationWastedAttempts' | 'speculationWasteMs'
  | 'wastedAttempts' | 'retryWasteMs' | 'stageFailureReason' | 'failedTaskSamples' | 'retryTaskSamples'>;

export type DetectorSqlExec = Pick<SqlExecution, 'id' | 'planTree' | 'description' | 'modifiedConfigs' | 'rootExecutionId' | 'commandArguments'>;

export type DetectorApp = Pick<SparkAppInfo, 'startTime' | 'endTime' | 'resources' | 'config' | 'sparkVersion' | 'rddInfo' | 'rddBlockUpdates'>;

type DetectorExecutorAddedEvent = Pick<ExecutorAddedEvent, 'executorId' | 'timestamp' | 'totalCores' | 'host'>;
type DetectorExecutorRemovedEvent = Pick<ExecutorRemovedEvent, 'executorId' | 'timestamp'>;
type DetectorJob = Pick<Job, 'result' | 'succeeded' | 'exception' | 'submissionTime' | 'completionTime'>;

// The full context analyze() passes as every stage/sql detect()'s second arg, and as the first
// arg for 'app' scope. 'config' scope gets a narrower `{ app }` (auditConfig) instead.
//
// `app` is nullable as on AppModel.app: a malformed or cut-short log may have no app record, so
// every app-reading detector guards it. `runAggregates.busyCoreMs` is optional for the same reason.
export interface DetectorCtx {
  app: DetectorApp | null;
  stages: Map<number, DetectorStage>;
  executorsAdded: DetectorExecutorAddedEvent[];
  executorsRemoved: DetectorExecutorRemovedEvent[];
  jobs: Map<number, DetectorJob>;
  sql: Map<number, DetectorSqlExec>;
  runAggregates?: Pick<RunAggregates, 'busyCoreMs' | 'perStage' | 'executorPeakMetrics'> | null;
  // The one EstimateCtx analyze() also hands every estimate(): a detector's runtime floor clips
  // its claim against the same occupancy sweep the displayed savings come from.
  impact: EstimateCtx;
  // skew's thresholds as resolved for this run (see skewThresholdsFor): straggler defers to skew's
  // gate and data cut, so it must judge a tail with the values skew itself uses.
  skewThresholds: SkewThresholds;
  // `stages` grouped by sqlExecutionId, built on first use (see sqlStageIds).
  stagesBySqlExecution?: Map<number, number[]>;
  // `sql` grouped by root execution, built on first use (see resolveDeltaCommandTarget).
  executionsByRoot?: ExecutionsByRoot;
}

// auditConfig(app) calls every config-scope detect({ app }) with whatever appModel.app is
// (SparkAppInfo | null), independent of DetectorCtx.
export interface DetectorConfigTarget {
  app: DetectorApp | null;
  // The run's stages, for config checks that apply only to some kinds of work. Absent when the caller
  // has none, in which case those checks stay silent.
  stages?: Map<number, DetectorStage>;
}

export interface SkewThresholds {
  ratioWarn: number; minTasksForP95: number; dataShareMin: number; floorPctWarn: number;
}

// Threshold field naming convention:
// *Pct = 0–1 fraction (normalized)
// *Pct100 = 0–100 scale
// *Ratio = multiplicative factor
// *Share/*Rate/*Util = 0–1 fraction (normalized)

/** A detector entry's threshold set. number[] too: slowHost's ratioTiers and broadcastSizing's
 * tiers are tier tables its detect() indexes by position. */
export type DetectorThresholds = Readonly<Record<string, number | readonly number[]>>;

export type DetectResult = Finding | Finding[] | null;

/** The intersection of a union's members: the type of one object merged from a table per member. */
export type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

// What each scope's detect() is handed. `thresholds` is the entry's own set, or the caller's
// overrides merged over it (analyze()'s `thresholds` option). 'config' has no DetectorCtx:
// auditConfig() runs those entries on the app alone.
interface DetectSignatures<T> {
  stage: (stage: DetectorStage, ctx: DetectorCtx, thresholds: T) => DetectResult;
  sql: (sqlExec: DetectorSqlExec, ctx: DetectorCtx, thresholds: T) => DetectResult;
  app: (ctx: DetectorCtx, thresholds: T) => DetectResult;
  config: (target: DetectorConfigTarget, thresholds: T) => DetectResult;
}

export type DetectorScope = keyof DetectSignatures<never>;

// The same calls with the thresholds already bound: what a runner holds after withThresholds().
export interface BoundDetectSignatures {
  stage: (stage: DetectorStage, ctx: DetectorCtx) => DetectResult;
  sql: (sqlExec: DetectorSqlExec, ctx: DetectorCtx) => DetectResult;
  app: (ctx: DetectorCtx) => DetectResult;
  config: (target: DetectorConfigTarget) => DetectResult;
}

// The fields a define*Detector() call spells out. `detect` is a property, not a method, so its
// parameters are checked contravariantly: a detect() that reads a threshold the entry doesn't
// declare, or expects a different target, fails to compile.
export interface DetectorSpec<
  S extends DetectorScope, TType extends string, TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, TSuppressor extends string,
> {
  type: TType;
  // Every finding `type` this entry pushes. Usually just its own `type`; broadcastSizing's one
  // plan walk emits underBroadcast/overBroadcast and never its own name. FindingType derives from it.
  emits: TEmits;
  // Display order only (widget sequence, verdict tie-breaks). Evaluation order never matters:
  // cross-detector suppression is the explicit `suppressedBy` below.
  order: number;
  fixEffort: FixEffort;
  // How this entry's finding bands are set (impact-band.ts): required, so a detector author's
  // choice of band is never replaced by omission.
  bandPolicy: BandPolicy;
  // A finding of this entry that grades under another policy than `bandPolicy`.
  gradeAs?(finding: FindingOf<TEmits[number]>): BandPolicy;
  version: number;
  docAnchor?: string;
  thresholds: T;
  inScorecard?: boolean;
  property?: string;
  // Another entry's `type`: analyze() drops this entry's finding on any stage that detector
  // flagged in the same run, whichever of the two is declared first.
  suppressedBy?: TSuppressor;
  detect: DetectSignatures<Readonly<T>>[S];
  // The impact estimate for one of this entry's findings, run after suppression; null leaves the
  // finding without one. Lives here so a finding type's waste model sits next to the detection
  // that produced it, reading the same helpers its runtime floor does.
  estimate: (finding: FindingOf<TEmits[number]>, ctx: EstimateCtx) => ImpactEstimate | null;
}

export type DefinedDetector<
  S extends DetectorScope, TType extends string, TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, TSuppressor extends string,
> = Omit<DetectorSpec<S, TType, TEmits, T, TSuppressor>, 'thresholds'> & {
  scope: S;
  thresholds: Readonly<T>;
  // detect() with this entry's thresholds bound, overridden per key by `overrides`. Throws on an
  // override key the entry doesn't declare or whose shape differs from the default's.
  withThresholds(overrides?: DetectorThresholds): BoundDetectSignatures[S];
};

/** How runners (analyze(), auditConfig(), the catalog helpers) see any DETECTORS entry: its
 * thresholds type erased and detect() left off, so they reach it only through withThresholds().
 * estimate() takes any Finding here: estimateImpact() only hands an entry the types it emits. */
export type Detector = {
  [S in DetectorScope]: Omit<DefinedDetector<S, string, readonly Finding['type'][], DetectorThresholds, string>, 'detect' | 'estimate'> & {
    estimate(finding: Finding, ctx: EstimateCtx): ImpactEstimate | null;
  };
}[DetectorScope];
