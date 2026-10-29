import { computeWallClock } from './wall-clock.ts';
import { normalizeDetail } from './detectors.ts';
import { normalizeStageName, stageIdentityWith, identityIndexWith, pairEqualCounts } from './stage-identity.ts';
import { computeAllocation } from './allocation.ts';
import { totalExecutorCpuMs, withEarlierAttempts } from './run-totals.ts';
import { captureSnapshot } from './session-snapshot.ts';
import { alignStages, compileNormalizePatterns, COMPARISON_SCHEMA_VERSION, type StageAlignment, type StagePair } from './stage-alignment.ts';
import { mdInline } from './markdown-inline.ts';
import { tunedRunNote } from './threshold-overrides.ts';
import { diffFindings, findingBand, findingKey, findingRule, type FindingLocator } from './finding-identity.ts';
import { cyrb53 } from './string-hash.ts';
import { IMPACT_BAND_ORDER, formatBytes, formatRawWaste, fmtMs } from './format-utils.ts';
import type { Stage, SparkAppInfo, AppModel, Finding, ImpactBand, TunedThresholds } from './types.ts';
import type { SessionSnapshot } from './session-snapshot.ts';
import type { ComparisonVerdictText, VerdictJobOutcome } from './comparison-verdict.ts';
import { isIncompleteRun } from './check-coverage.ts';
import { stageDisplayLabel } from './stage-label.ts';
import { runAppIdentity, type RunAppIdentity } from './run-identity.ts';
import { summarizeRunOutcome } from './run-outcome.ts';
import { buildComparability, withinBand, type CaveatThresholds, type Comparability, type VolumeFigure } from './comparability.ts';

export interface MetricDeltaRow {
  key: string; label: string;
  baseline: number | null; candidate: number | null; delta: number | null;
  direction: 'improvement' | 'regression' | 'unchanged' | 'neutral' | 'unavailable';
  unavailableReason?: string;
  /** Both sides are measured and the candidate sits within the noise band of the baseline. Never
   * changes `direction`, which budgets read. */
  withinNoise: boolean;
}
// An introduced or resolved finding category: the findings of one rule and band that have no
// counterpart in the other run. An introduced row has `baseCount` 0, a resolved row `candCount` 0.
// `keys`: the `key` of each finding the row counts, as `diagnose_run` reports it for the run the
// findings are in (the candidate for an introduced row, the baseline for a resolved one).
export interface FindingsDeltaRow {
  rule: string; type: string; impactBand: string; baseCount: number; candCount: number; delta: number; stages: string[];
  /** `stages` as display labels, each name with the directories of its call-site path removed. */
  stageLabels: string[];
  keys: string[];
}
// Findings both runs have, at one location, that moved from one impact band to another. `count`
// is how many findings of that rule moved between those two bands.
// `keys` are the candidate run's finding keys, `baseKeys` the baseline's: a pair the aligner matched
// without an exact fingerprint match has different keys on the two sides.
export interface FindingsChangedRow {
  rule: string; type: string; baseImpactBand: string; candImpactBand: string; count: number; stages: string[];
  /** `stages` as display labels, each name with the directories of its call-site path removed. */
  stageLabels: string[];
  keys: string[]; baseKeys: string[];
}
/** True when a changed finding moved to a more severe band (an unknown band ranks least severe). */
export function isEscalation(row: Pick<FindingsChangedRow, 'baseImpactBand' | 'candImpactBand'>): boolean {
  const rank = (band: string) => IMPACT_BAND_ORDER[band as ImpactBand] ?? 9;
  return rank(row.candImpactBand) < rank(row.baseImpactBand);
}
export interface FindingsDelta {
  introduced: FindingsDeltaRow[]; resolved: FindingsDeltaRow[]; changed: FindingsChangedRow[];
}
export interface StageSkewRow {
  pairId: string; name: string; baseId: number; candId: number;
  baseline: number | null; candidate: number | null; delta: number | null;
}
/** A stage pair with its stage name as a display label (call-site directories removed). The pair
 * carries no raw name, so the label is the only name on the row. */
export interface LabeledStagePair extends StagePair { stageLabel: string }
export interface CompareRunsResult {
  baselineLabel: string; candidateLabel: string;
  baselineApp: RunAppIdentity; candidateApp: RunAppIdentity;
  // Log lines the baseline's parser skipped as malformed or invalid; above 0 its totals can be
  // understated. The candidate's count is in its own run summary.
  baselineSkippedLines: number;
  // `insufficient`: neither run recorded any executor run time, so there is nothing to compare.
  confidence: 'ok' | 'low' | 'insufficient'; reason: string | null;
  // Share of stages the exact matcher (`matchStages`) paired, by count. `runtimeCoverage` is
  // the gate: the share of executor run time that sits in paired stages.
  matchedCoverage: number;
  comparisonSchemaVersion: typeof COMPARISON_SCHEMA_VERSION;
  runtimeCoverage: number | null;
  stagePairs: LabeledStagePair[];
  unmatched: StageAlignment['unmatched'];
  replanned: StageAlignment['replanned'];
  bookkeepingStageIds: StageAlignment['bookkeepingStageIds'];
  executionAlignment: StageAlignment['executionAlignment'];
  metrics: MetricDeltaRow[];
  findings: FindingsDelta;
  stageSkew: StageSkewRow[];
  baseStages: Array<{ id: number; name: string; metrics: StageMetricsRow }>;
  candStages: Array<{ id: number; name: string; metrics: StageMetricsRow }>;
  // Each run's job results as its own run verdict counts them, and whether its log lacks an
  // end-of-run record: the comparison verdict leads with failed jobs and never calls a cut-off
  // log's shorter time a speed-up.
  jobOutcomes: { baseline: VerdictJobOutcome; candidate: VerdictJobOutcome };
  comparability: Comparability;
}

function jobOutcome(snapshot: SessionSnapshot): VerdictJobOutcome {
  const { failedJobs, totalJobs } = summarizeRunOutcome(snapshot.jobs, snapshot.catalog);
  return { failedJobs, totalJobs, incomplete: isIncompleteRun(snapshot.catalog) };
}

export { normalizeStageName };

export function stageIdentity(stage: Stage, snapshot: Pick<SessionSnapshot, 'sql'>): string {
  return stageIdentityWith(stage, snapshot, normalizeDetail);
}

/** The key a finding row carries (`findingKey`: type, rule and location) with the location read off
 * the run alone: a stage by its `stageIdentity` fingerprint (the keys of `metrics.stages`), an SQL
 * execution by a digest of its stages' fingerprints. Two runs of the same job give the same finding
 * the same key, so a reader pairs findings across runs without the aligner. A pairing aid: several
 * findings can share a key (one detector firing per host on a run-level key, stages that share a
 * fingerprint), and it says nothing about whether the finding's value or band held. */
export function findingKeyer(snapshot: Pick<SessionSnapshot, 'stages' | 'sql'>): (finding: Finding) => string {
  const stageLabels = new Map<number, string>();
  const stageLabel = (id: number): string => {
    let label = stageLabels.get(id);
    if (label === undefined) {
      const stage = snapshot.stages.get(id);
      label = stage ? stageIdentity(stage, snapshot) : `#${id}`;
      stageLabels.set(id, label);
    }
    return label;
  };
  let stagesByExecution: Map<number, number[]> | undefined;
  const executionLabel = (id: number): string => {
    if (!stagesByExecution) {
      stagesByExecution = new Map();
      for (const [stageId, stage] of snapshot.stages) {
        if (stage.sqlExecutionId == null) continue;
        const ids = stagesByExecution.get(stage.sqlExecutionId);
        if (ids) ids.push(stageId); else stagesByExecution.set(stage.sqlExecutionId, [stageId]);
      }
    }
    const ids = stagesByExecution.get(id);
    // An execution with no stage has no fingerprint to digest: its id is all that names it.
    return ids ? cyrb53(JSON.stringify(ids.map(stageLabel).sort())) : `#${id}`;
  };
  const locator: FindingLocator = { stage: stageLabel, execution: executionLabel };
  return (finding) => findingKey(finding, locator);
}

export function matchStages(baseSnap: SessionSnapshot, candSnap: SessionSnapshot): {
  pairs: Array<{ identity: string; baseId: number; candId: number }>;
  matchedIdentities: Set<string>;
  collisionIdentities: Set<string>;
  coverage: number;
} {
  const baseIdx = identityIndexWith(baseSnap, (stage) => stageIdentity(stage, baseSnap));
  const candIdx = identityIndexWith(candSnap, (stage) => stageIdentity(stage, candSnap));
  const collisionIdentities = new Set<string>();
  // A collision is a single-run property: more than one stage in the SAME run
  // shares an identity. Recorded per-run regardless of whether the other run
  // shares it too. Some collisions get resolved into `pairs` below and some
  // don't, so this set means "was ambiguous", not "stayed unpaired".
  for (const idx of [baseIdx, candIdx])
    for (const [identity, ids] of idx) if (ids.length > 1) collisionIdentities.add(identity);
  const { pairs, matchedIdentities } = pairEqualCounts(baseIdx, candIdx);
  const total = baseSnap.stages.size + candSnap.stages.size;
  // Both runs stage-less: nothing to compare, not "nothing matched".
  const coverage = total === 0 ? 1 : (2 * pairs.length) / total;
  return { pairs, matchedIdentities, collisionIdentities, coverage };
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length) - 1; // nearest-rank, deterministic
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

// The stage numeric fields sumField/perStageMetrics read; keeps the generic
// `field` parameter narrowed to a known numeric Stage property instead of
// widening to `string` (Stage also carries a `[key: string]: unknown` index
// signature for detector-only fields).
type NumericStageField =
  | 'memoryBytesSpilled' | 'diskBytesSpilled' | 'jvmGCTime' | 'inputBytes'
  | 'outputBytes' | 'executorRunTime' | 'taskCount' | 'failedTasks';

// Sum a numeric stage field over a stage list; `present` is false when no stage
// carried a finite value (so the metric renders Unavailable rather than a false 0).
function sumField(stages: Stage[], field: NumericStageField): { sum: number; present: boolean } {
  let sum = 0, present = false;
  for (const s of stages) {
    const v = s[field];
    if (Number.isFinite(v)) { sum += v as number; present = true; }
  }
  return { sum, present };
}

// Shared by skewRatios (whole-run p95 input) and stageSkewDeltas' `ratio`
// closure (per-pair matched comparison): both need the identical per-stage
// task-skew formula (max task duration over stage wall-clock duration).
function stageSkewRatio(stage: Stage): number | null {
  const dur = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  return dur > 0 && Number.isFinite(stage.taskDurationMax) ? (stage.taskDurationMax as number) / dur : null;
}

function skewRatios(stages: Stage[]): number[] {
  const out: number[] = [];
  for (const s of stages) {
    const ratio = stageSkewRatio(s);
    if (ratio != null) out.push(ratio);
  }
  return out;
}

// Every key metricDeltas() emits, in emission order. The CLI validates
// --regression-metric against it, so a misspelled key is a usage error rather
// than an inconclusive budget. A contract test keeps it in sync.
export const COMPARISON_METRIC_KEYS: readonly string[] = [
  'wallClock', 'shuffleSpill', 'taskSkew', 'failedTaskRate', 'diskSpill', 'gcTime',
  'inputBytes', 'outputBytes', 'executorRunTime', 'taskCount', 'executorsAdded',
  'executorCpuTime', 'allocatedCoreHours',
];

// Volume/count metrics have no better/worse direction: more input, output, tasks or executors may
// just reflect a differently-sized job. Shared by the view (Δ coloring) and by the CLI's
// checkRegression, so a `--regression-metric inputBytes` budget cannot read more data as a regression.
export const NEUTRAL_METRIC_KEYS: ReadonlySet<string> = new Set(['inputBytes', 'outputBytes', 'taskCount', 'executorsAdded']);

/** Which way a change in the metric reads: neutral for volume and count metrics, else less is better. */
export function direction(key: string, baseline: number | null, candidate: number | null): MetricDeltaRow['direction'] {
  if (baseline == null || candidate == null) return 'unavailable';
  if (NEUTRAL_METRIC_KEYS.has(key)) return candidate === baseline ? 'unchanged' : 'neutral';
  const d = candidate - baseline;
  return d < 0 ? 'improvement' : d > 0 ? 'regression' : 'unchanged';
}

/** A change under this share of the baseline's value is within run-to-run noise: a shared cluster
 * easily moves a job a percent or two. The caller's `noiseBand` replaces it. */
export const DEFAULT_NOISE_BAND = 0.02;

/** Where the comparison verdict starts to call out a difference between the runs. The caller's
 * `caveatThresholds` replace them. */
export const DEFAULT_CAVEAT_THRESHOLDS: CaveatThresholds = { executorRatio: 1.5, unmatchedShare: 0.2, taskCountChange: 0.25 };

export function metricDeltas(baseSnap: SessionSnapshot, candSnap: SessionSnapshot, noiseBand = DEFAULT_NOISE_BAND): MetricDeltaRow[] {
  const metric = (
    key: string, label: string, baseline: number | null, candidate: number | null,
    extra: { unavailableReason?: string } = {},
  ): MetricDeltaRow => {
    const delta = baseline == null || candidate == null ? null : candidate - baseline;
    return {
      key, label, baseline, candidate, delta, direction: direction(key, baseline, candidate),
      withinNoise: baseline != null && candidate != null && withinBand(baseline, candidate, noiseBand), ...extra,
    };
  };
  const out: MetricDeltaRow[] = [];
  // Run totals count every task attempt, failed and speculative ones too (run-totals.ts), the
  // same sums the CLI metrics block reports; skew stays on each stage's latest attempt.
  const attemptsOf = (snap: SessionSnapshot): Stage[] => withEarlierAttempts([...snap.stages.values()]);

  // Wall-clock: always computable (computeWallClock tolerates a null app).
  out.push(metric('wallClock', 'Wall-clock duration',
    computeWallClock(baseSnap.app, baseSnap.stages).total,
    computeWallClock(candSnap.app, candSnap.stages).total));

  // Memory spill (Spark's memoryBytesSpilled) over the whole run: a sum needs no
  // stage matching, and matching is unreliable on real logs, so scope it to all
  // stages exactly like task-skew and failed-rate below. The key stays
  // `shuffleSpill` so existing --regression-metric callers keep working.
  const bSpill = sumField(attemptsOf(baseSnap), 'memoryBytesSpilled');
  const cSpill = sumField(attemptsOf(candSnap), 'memoryBytesSpilled');
  out.push(metric('shuffleSpill', 'Memory spill',
    bSpill.present ? bSpill.sum : null, cSpill.present ? cSpill.sum : null,
    { unavailableReason: bSpill.present && cSpill.present ? undefined : 'No memory-spill data recorded for a run' }));

  // Task skew: p95 of per-stage ratio across the whole run.
  const bSkew = p95(skewRatios([...baseSnap.stages.values()]));
  const cSkew = p95(skewRatios([...candSnap.stages.values()]));
  out.push(metric('taskSkew', 'Task skew (p95)', bSkew, cSkew,
    { unavailableReason: bSkew != null && cSkew != null ? undefined : 'No stage had measurable duration for a run' }));

  // Failed-task rate: Σ failedTasks / Σ taskCount.
  const bTasks = sumField(attemptsOf(baseSnap), 'taskCount');
  const cTasks = sumField(attemptsOf(candSnap), 'taskCount');
  const bFailed = sumField(attemptsOf(baseSnap), 'failedTasks');
  const cFailed = sumField(attemptsOf(candSnap), 'failedTasks');
  // Guard on BOTH inputs: a missing `failedTasks` field must render Unavailable,
  // not a false 0% rate (dividing an absent-and-therefore-0 numerator).
  const bRate = bTasks.present && bTasks.sum > 0 && bFailed.present ? bFailed.sum / bTasks.sum : null;
  const cRate = cTasks.present && cTasks.sum > 0 && cFailed.present ? cFailed.sum / cTasks.sum : null;
  out.push(metric('failedTaskRate', 'Failed-task rate', bRate, cRate,
    { unavailableReason: bRate != null && cRate != null ? undefined : 'No task or failure counts recorded for a run' }));

  // Additional whole-run aggregates: plain sums of fields the stage already
  // carries (set in finalizeStage). Correct at any match coverage, like the
  // sums above; no parser or detector change.
  const sumMetric = (key: string, label: string, field: NumericStageField, reason: string) => {
    const b = sumField(attemptsOf(baseSnap), field);
    const c = sumField(attemptsOf(candSnap), field);
    out.push(metric(key, label, b.present ? b.sum : null, c.present ? c.sum : null,
      { unavailableReason: b.present && c.present ? undefined : reason }));
  };
  sumMetric('diskSpill', 'Disk spill', 'diskBytesSpilled', 'No disk-spill data recorded for a run');
  sumMetric('gcTime', 'GC time', 'jvmGCTime', 'No GC-time data recorded for a run');
  sumMetric('inputBytes', 'Input read', 'inputBytes', 'No input-bytes data recorded for a run');
  sumMetric('outputBytes', 'Output written', 'outputBytes', 'No output-bytes data recorded for a run');
  sumMetric('executorRunTime', 'Executor run-time', 'executorRunTime', 'No executor run-time recorded for a run');
  sumMetric('taskCount', 'Task count', 'taskCount', 'No task counts recorded for a run');

  // Executor count is app-level, not per-stage. `executors` is absent on
  // hand-built snapshots; guard so it renders Unavailable, not a crash.
  const execCount = (snap: SessionSnapshot): number | null =>
    (Array.isArray(snap.executors?.added) ? snap.executors.added.length : null);
  const bExec = execCount(baseSnap), cExec = execCount(candSnap);
  out.push(metric('executorsAdded', 'Executors added', bExec, cExec,
    { unavailableReason: bExec != null && cExec != null ? undefined : 'No executor events recorded for a run' }));

  // Executor CPU time (ms) and allocated core-hours cost resources, so less is better. CPU time is
  // null, not 0, on a run whose log never recorded it (older Spark).
  const cpuMs = (snap: SessionSnapshot): number | null => totalExecutorCpuMs(attemptsOf(snap));
  const bCpu = cpuMs(baseSnap), cCpu = cpuMs(candSnap);
  out.push(metric('executorCpuTime', 'Executor CPU time', bCpu, cCpu,
    { unavailableReason: bCpu != null && cCpu != null ? undefined : 'No executor CPU time recorded for a run' }));
  const coreHours = (snap: SessionSnapshot): number | null =>
    (snap.executors ? computeAllocation(snap).coreHours : null);
  const bCore = coreHours(baseSnap), cCore = coreHours(candSnap);
  out.push(metric('allocatedCoreHours', 'Allocated core-hours', bCore, cCore,
    { unavailableReason: bCore != null && cCore != null ? undefined : 'No executor lifecycle or core count recorded for a run' }));

  return out;
}

// Cross-run identity of a snapshot's stages and SQL executions: a stage (or execution) the aligner
// paired takes one label on both sides; an unpaired one takes a side-neutral label, so the same problem on an unpaired stage in both runs still matches.
function findingLocators(baseSnap: SessionSnapshot, candSnap: SessionSnapshot, stagePairs: StagePair[]): { base: FindingLocator; cand: FindingLocator } {
  const baseStage = new Map<number, string>(), candStage = new Map<number, string>();
  const executionVotes = new Map<number, Map<number, number>>(); // base execution -> cand execution -> paired stages
  for (const pair of stagePairs) {
    baseStage.set(pair.baseStageIds[0], pair.pairId);
    candStage.set(pair.candStageIds[0], pair.pairId);
    const baseExec = baseSnap.stages.get(pair.baseStageIds[0])?.sqlExecutionId;
    const candExec = candSnap.stages.get(pair.candStageIds[0])?.sqlExecutionId;
    if (baseExec == null || candExec == null) continue;
    const votes = executionVotes.get(baseExec) ?? new Map<number, number>();
    votes.set(candExec, (votes.get(candExec) ?? 0) + 1);
    executionVotes.set(baseExec, votes);
  }
  // An execution pairs with the candidate execution that holds most of its paired stages.
  const executionPair = new Map<number, number>();
  for (const [baseExec, votes] of executionVotes) {
    const [candExec] = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    executionPair.set(baseExec, candExec);
  }
  const pairedCandExecs = new Set(executionPair.values());
  return {
    base: { stage: (id) => baseStage.get(id) ?? 'unpaired', execution: (id) => executionPair.has(id) ? `c${executionPair.get(id)}` : 'unpaired' },
    cand: { stage: (id) => candStage.get(id) ?? 'unpaired', execution: (id) => pairedCandExecs.has(id) ? `c${id}` : 'unpaired' },
  };
}

// A finding is the same finding in both runs when `findingKey` says so (type, rule and location,
// never value or band). One with a counterpart is not introduced or resolved: a different band
// makes it `changed`. Each row aggregates findings of one rule and band, with the stage names
// of the side the findings are on.
export function findingsDelta(baseSnap: SessionSnapshot, candSnap: SessionSnapshot, stagePairs: StagePair[] = []): FindingsDelta {
  const locators = findingLocators(baseSnap, candSnap, stagePairs);
  const diff = diffFindings(baseSnap.catalog, candSnap.catalog, locators.base, locators.cand);
  const stageNames = (snap: SessionSnapshot, findings: Finding[]): string[] => {
    const names = new Set<string>();
    for (const f of findings) {
      const name = f.stageId != null ? snap.stages.get(f.stageId)?.name : undefined;
      if (name) names.add(name);
    }
    return [...names].sort();
  };
  const stageLabelsOf = (names: string[]): string[] => [...new Set(names.map(stageDisplayLabel))].sort();
  const baseKeyOf = findingKeyer(baseSnap), candKeyOf = findingKeyer(candSnap);
  const keysOf = (findings: Finding[], keyOf: (f: Finding) => string): string[] => [...new Set(findings.map(keyOf))].sort();
  const group = <T>(items: T[], keyOf: (item: T) => string): Array<[string, T[]]> => {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const key = keyOf(item);
      const members = groups.get(key);
      if (members) members.push(item); else groups.set(key, [item]);
    }
    return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  };
  const rows = (findings: Finding[], snap: SessionSnapshot, side: 'base' | 'cand'): FindingsDeltaRow[] =>
    group(findings, (f) => `${findingRule(f)}§${findingBand(f)}`).map(([, fs]) => {
      const count = fs.length;
      const stages = stageNames(snap, fs);
      return {
        rule: findingRule(fs[0]), type: fs[0].type, impactBand: findingBand(fs[0]),
        baseCount: side === 'base' ? count : 0, candCount: side === 'cand' ? count : 0,
        delta: side === 'cand' ? count : -count, stages, stageLabels: stageLabelsOf(stages),
        keys: keysOf(fs, side === 'cand' ? candKeyOf : baseKeyOf),
      };
    });
  const changed: FindingsChangedRow[] = group(
    diff.changed, (c) => `${findingRule(c.candidate)}§${findingBand(c.baseline)}§${findingBand(c.candidate)}`,
  ).map(([, cs]) => {
    const stages = stageNames(candSnap, cs.map((c) => c.candidate));
    return {
      rule: findingRule(cs[0].candidate), type: cs[0].candidate.type,
      baseImpactBand: findingBand(cs[0].baseline), candImpactBand: findingBand(cs[0].candidate),
      count: cs.length, stages, stageLabels: stageLabelsOf(stages),
      keys: keysOf(cs.map((c) => c.candidate), candKeyOf), baseKeys: keysOf(cs.map((c) => c.baseline), baseKeyOf),
    };
  });
  return { introduced: rows(diff.introduced, candSnap, 'cand'), resolved: rows(diff.resolved, baseSnap, 'base'), changed };
}

function namesConflict(a: SparkAppInfo | null, b: SparkAppInfo | null): boolean {
  return a?.name != null && b?.name != null && a.name !== b.name;
}

// A pair's skew ratio is null when the stage's duration wasn't measurable (see
// `stageSkewRatio`). Rows come from the aligner's `stagePairs`, so the table and the coverage
// banner agree. A pair covers one stage per side here; `pairId` is the unique row key.
function stageSkewDeltas(baseSnap: SessionSnapshot, candSnap: SessionSnapshot, stagePairs: StagePair[]): StageSkewRow[] {
  return stagePairs.map((p) => {
    const baseId = p.baseStageIds[0], candId = p.candStageIds[0];
    const baseStage = baseSnap.stages.get(baseId)!;
    const b = stageSkewRatio(baseStage);
    const c = stageSkewRatio(candSnap.stages.get(candId)!);
    return {
      pairId: p.pairId, name: normalizeStageName(baseStage.name ?? ''), baseId, candId,
      baseline: b, candidate: c, delta: b != null && c != null ? c - b : null,
    };
  }).sort((x, y) => x.name < y.name ? -1 : x.name > y.name ? 1 : x.baseId - y.baseId);
}

// Compact, view-friendly per-stage record for the manual stage-pinning panel.
// Every field is number | null; a null means the stage did not carry it.
// Exported: it's CompareRunsResult['baseStages'/'candStages']'s metrics type.
export interface StageMetricsRow {
  duration: number | null;
  memoryBytesSpilled: number | null;
  diskBytesSpilled: number | null;
  jvmGCTime: number | null;
  inputBytes: number | null;
  outputBytes: number | null;
  executorRunTime: number | null;
  taskCount: number | null;
  failedTasks: number | null;
}

function perStageMetrics(stage: Stage): StageMetricsRow {
  const num = (v: unknown): number | null => (Number.isFinite(v) ? (v as number) : null);
  const dur = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  return {
    duration: dur > 0 ? dur : null,
    memoryBytesSpilled: num(stage.memoryBytesSpilled),
    diskBytesSpilled: num(stage.diskBytesSpilled),
    jvmGCTime: num(stage.jvmGCTime),
    inputBytes: num(stage.inputBytes),
    outputBytes: num(stage.outputBytes),
    executorRunTime: num(stage.executorRunTime),
    taskCount: num(stage.taskCount),
    failedTasks: num(stage.failedTasks),
  };
}

function stageList(snap: SessionSnapshot): Array<{ id: number; name: string; metrics: StageMetricsRow }> {
  return [...snap.stages].map(([id, s]) => ({ id, name: s.name ?? `Stage ${id}`, metrics: perStageMetrics(s) }));
}

// captureSnapshot copies this into a fresh Map internally and never mutates the
// caller's reference, so one shared empty Map is safe here.
const EMPTY_TASK_DATA = new Map<number, unknown>();

export interface CompareOptions {
  /** Caller-supplied regular expressions (sources), applied to plan node detail before stages are
   * paired: every match is replaced with a fixed token, so run-specific text such as a per-run
   * output directory does not split a stage in two. Findings and `stageIdentity` never see them.
   * Invalid, over-long or empty-matching patterns throw (see `compileNormalizePatterns`). */
  normalizePath?: readonly string[];
  /** Regular expression sources matched against Spark configuration keys: a key that matches one
   * is left out of the configuration comparison, for keys that differ by design such as a per-run
   * output path. Invalid, over-long or empty patterns throw. */
  ignoreConf?: readonly string[];
  /** Extra secret pattern for the configuration comparison, as the CLI's `--conf-redact-regex`:
   * a property whose key or value matches is withheld from both sides and not compared. */
  confRedactRegex?: string;
  /** Share of the baseline's value under which a metric row is `withinNoise`; default
   * `DEFAULT_NOISE_BAND`. Must be a finite number from 0 to 1. */
  noiseBand?: number;
  /** Overrides for `DEFAULT_CAVEAT_THRESHOLDS`, each validated against its range. */
  caveatThresholds?: Partial<CaveatThresholds>;
}

// Snapshot-building shared by the CLI's --baseline path and mcp-tools.ts's compareRuns tool. The
// empty taskDataCache is the interactive drill-down cache, which comparison never reads.
export function buildComparison(
  baseline: { label: string; appModel: AppModel; catalog: Finding[] },
  candidate: { label: string; appModel: AppModel; catalog: Finding[] },
  options?: CompareOptions,
): CompareRunsResult {
  return compareRuns(
    { label: baseline.label, snapshot: captureSnapshot(baseline.appModel, baseline.catalog, EMPTY_TASK_DATA) },
    { label: candidate.label, snapshot: captureSnapshot(candidate.appModel, candidate.catalog, EMPTY_TASK_DATA) },
    options,
  );
}

// `ok` needs this share of both runs' executor run time to sit in paired stages. Run time, not
// stage count: the stages a run spends its time in decide whether a per-stage delta compares the
// same work, and a count lets many small matched stages hide an unmatched heavy one.
const RUNTIME_COVERAGE_THRESHOLD = 0.9;

export function compareRuns(
  baseline: { label: string; snapshot: SessionSnapshot },
  candidate: { label: string; snapshot: SessionSnapshot },
  options: CompareOptions = {},
): CompareRunsResult {
  const baseSnap = baseline.snapshot, candSnap = candidate.snapshot;
  const noiseBand = options.noiseBand ?? DEFAULT_NOISE_BAND;
  if (!Number.isFinite(noiseBand) || noiseBand < 0 || noiseBand > 1) {
    throw new Error(`noiseBand must be a number from 0 to 1, got ${noiseBand}.`);
  }
  const given = options.caveatThresholds;
  const executorRatio = given?.executorRatio ?? DEFAULT_CAVEAT_THRESHOLDS.executorRatio;
  const unmatchedShare = given?.unmatchedShare ?? DEFAULT_CAVEAT_THRESHOLDS.unmatchedShare;
  const taskCountChange = given?.taskCountChange ?? DEFAULT_CAVEAT_THRESHOLDS.taskCountChange;
  if (!Number.isFinite(executorRatio) || executorRatio < 1) throw new Error(`executorRatio must be a number of 1 or more, got ${executorRatio}.`);
  if (!Number.isFinite(unmatchedShare) || unmatchedShare < 0 || unmatchedShare > 1) throw new Error(`unmatchedShare must be a number from 0 to 1, got ${unmatchedShare}.`);
  if (!Number.isFinite(taskCountChange) || taskCountChange < 0) throw new Error(`taskCountChange must be a number of 0 or more, got ${taskCountChange}.`);
  // `matchedCoverage` comes from the exact matcher; pairs and the gate come from the aligner.
  const match = matchStages(baseSnap, candSnap);
  const alignment = alignStages(baseSnap, candSnap, { normalizePath: compileNormalizePatterns(options.normalizePath) });
  const runtimeCoverage = alignment.runtimeCoverage;
  // Name equality is a weak confidence signal, not a hard gate: renaming a job
  // is the normal way to label an A/B experiment, so a mismatch must not block
  // the (matching-free, name-independent) deltas. Surface it as `low` instead.
  const namesDiffer = namesConflict(baseSnap.app, candSnap.app);
  // Runtime coverage is the other half of the signal: identical names on two runs whose heavy
  // stages do not pair are just as misleading as differing names on two runs that pair well, so
  // either condition alone drops confidence to `low`. No run time at all is `insufficient`.
  const insufficient = runtimeCoverage === null;
  const lowCoverage = runtimeCoverage !== null && runtimeCoverage < RUNTIME_COVERAGE_THRESHOLD;
  const confidence: CompareRunsResult['confidence'] = insufficient ? 'insufficient' : namesDiffer || lowCoverage ? 'low' : 'ok';
  // Rounded down, so a share just under the gate never reads as 90%.
  const share = runtimeCoverage === null ? '' : `${Math.floor(runtimeCoverage * 100)}%`;
  const reason = insufficient
    ? `${namesDiffer ? 'Run names differ and no' : 'No'} executor run time was recorded in either run, so there is no work to compare.`
    : namesDiffer && lowCoverage
    ? `Run names differ and only ${share} of executor run time is in matched stages, so deltas may compare different work.`
    : namesDiffer
    ? 'Run names differ, so deltas may compare different work.'
    : lowCoverage
    ? `Only ${share} of executor run time is in matched stages, so per-stage rows mostly compare unrelated work.`
    : null;
  const metrics = metricDeltas(baseSnap, candSnap, noiseBand);
  return {
    baselineLabel: baseline.label, candidateLabel: candidate.label,
    baselineApp: runAppIdentity(baseSnap.app), candidateApp: runAppIdentity(candSnap.app),
    baselineSkippedLines: baseSnap.skippedLines ?? 0,
    confidence,
    reason,
    matchedCoverage: match.coverage,
    comparisonSchemaVersion: COMPARISON_SCHEMA_VERSION,
    runtimeCoverage,
    stagePairs: alignment.pairs.map((p) => ({
      ...p, stageLabel: stageDisplayLabel(baseSnap.stages.get(p.baseStageIds[0])?.name ?? ''),
    })),
    unmatched: alignment.unmatched,
    replanned: alignment.replanned,
    bookkeepingStageIds: alignment.bookkeepingStageIds,
    executionAlignment: alignment.executionAlignment,
    metrics,
    findings: findingsDelta(baseSnap, candSnap, alignment.pairs),
    stageSkew: stageSkewDeltas(baseSnap, candSnap, alignment.pairs),
    baseStages: stageList(baseSnap),
    candStages: stageList(candSnap),
    jobOutcomes: { baseline: jobOutcome(baseSnap), candidate: jobOutcome(candSnap) },
    comparability: buildComparability(baseSnap, candSnap, alignment, metrics, { ignoreConf: options.ignoreConf, confRedactRegex: options.confRedactRegex, noiseBand, caveatThresholds: { executorRatio, unmatchedShare, taskCountChange } }),
  };
}

// One introduced/resolved findings-delta block: `### <title> (<count>)`
// heading followed by one bullet per finding.
function renderFindingsSection(title: string, findings: FindingsDeltaRow[]): string[] {
  const lines = [`### ${title} (${findings.length})`, ''];
  for (const f of findings) {
    lines.push(`- [${f.impactBand}] ${f.rule}: ${f.baseCount} -> ${f.candCount}`);
  }
  return lines;
}

// Findings both runs have whose impact band moved: `### Changed findings (<count>)`, one bullet each.
function renderChangedSection(changed: FindingsChangedRow[]): string[] {
  const lines = [`### Changed findings (${changed.length})`, ''];
  for (const f of changed) {
    lines.push(`- ${f.rule}: ${f.baseImpactBand} -> ${f.candImpactBand}${f.count > 1 ? ` (${f.count} findings)` : ''}`);
  }
  return lines;
}

// Markdown unit per metric key; a key with none prints its number as is.
const bytesText = (bytes: number): string => (bytes === 0 ? '0 B' : bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : formatBytes(bytes));
const METRIC_TEXT: Record<string, (value: number) => string> = {
  wallClock: fmtMs, gcTime: fmtMs, executorRunTime: fmtMs, executorCpuTime: fmtMs,
  shuffleSpill: bytesText, diskSpill: bytesText, inputBytes: bytesText, outputBytes: bytesText,
  taskSkew: (ratio) => ratio.toFixed(3),
  failedTaskRate: (rate) => `${(rate * 100).toFixed(2)}%`,
  allocatedCoreHours: (value) => formatRawWaste({ value, unit: 'coreHours' }),
};

const orNa = (value: number | null, format: (value: number) => string): string => (value == null ? 'n/a' : format(value));

/** "+63%" for a relative change, one decimal under 1%; null when there is no change to state. */
function changeText(relative: number | null): string | null {
  if (relative == null) return null;
  const percent = relative * 100;
  const text = Math.abs(percent) < 1 ? percent.toFixed(1) : String(Math.round(percent));
  return Number(text) === 0 ? '0.0%' : `${percent > 0 ? '+' : ''}${text}%`;
}

// What the runs share, as `- key: value` bullets: configuration, plan, data volume and executors.
function renderComparabilitySection({ conf, plan, volume, capacity }: Comparability): string[] {
  const confLine = conf.equal == null ? 'a run records no Spark properties'
    : conf.equal ? 'same' : `${conf.differences.length} differ (${mdInline(conf.differences.map((d) => d.key).join(', '))})`;
  const pair = (f: VolumeFigure, format: (value: number) => string = String) =>
    `${orNa(f.baseline, format)} -> ${orNa(f.candidate, format)}${f.relativeDifference == null ? '' : ` (${changeText(f.relativeDifference)})`}`;
  const execs = (side: { meanExecutors: number | null; peakExecutors: number | null }) =>
    `${side.meanExecutors == null ? 'n/a' : side.meanExecutors.toFixed(1)} mean / ${side.peakExecutors ?? 'n/a'} peak`;
  return [
    '### Comparability', '',
    `- configuration: ${confLine}`,
    `- plan: ${plan.equal ? 'every stage pairs' : `${plan.unmatched.baseline} baseline / ${plan.unmatched.candidate} candidate stages unmatched, ${plan.replanned} re-planned`}`,
    `- input bytes: ${pair(volume.inputBytes, bytesText)}, output rows: ${pair(volume.outputRows)}, output bytes: ${pair(volume.outputBytes, bytesText)}`,
    `- executors: ${execs(capacity.baseline)} -> ${execs(capacity.candidate)}`,
  ];
}

// Small Markdown renderer for the comparison section, matching
// evidence-report.ts's renderMarkdown house style (## section heading, ###
// subheadings, `- key: value` bullets). Shared by the CLI's --baseline
// markdown output and the MCP server's compare_runs `format: 'md'`.
/** `tuned`: tunedDetectors() for the overrides both runs were analyzed with, named in the output
 * as the evidence report names them. */
export function renderComparisonMarkdown(
  comparison: CompareRunsResult, verdict?: ComparisonVerdictText, tuned?: Record<string, TunedThresholds> | null,
): string {
  const lines = ['', '## Comparison to baseline', ''];
  if (tuned) lines.push(`- Tuned thresholds (both runs): ${tunedRunNote(tuned)}`, '');
  if (verdict) {
    // Names each run by its label (MCP's run IDs), unless the labels are just the role names the
    // CLI passes, where the verdict below already says baseline and candidate.
    if (comparison.baselineLabel !== 'baseline' || comparison.candidateLabel !== 'candidate') {
      lines.push(`Baseline: ${mdInline(comparison.baselineLabel)} · Candidate: ${mdInline(comparison.candidateLabel)}`, '');
    }
    lines.push(mdInline(verdict.title));
    if (verdict.sentences.length > 0) lines.push('', mdInline(verdict.sentences.join(' ')));
    lines.push('');
  }
  if (comparison.confidence !== 'ok') {
    lines.push(`- confidence: ${comparison.confidence}, ${comparison.reason}`);
    lines.push('');
  }
  if (comparison.baselineSkippedLines > 0) {
    lines.push(`- Baseline skipped lines: ${comparison.baselineSkippedLines} (malformed or invalid log lines; baseline totals cover only the lines that parsed)`);
  }
  lines.push(`- matched stage coverage: ${(comparison.matchedCoverage * 100).toFixed(1)}%`);
  lines.push(`- runtime coverage: ${comparison.runtimeCoverage === null ? 'n/a' : `${(comparison.runtimeCoverage * 100).toFixed(1)}%`}`);
  lines.push(`- stage pairs: ${comparison.stagePairs.length}, unmatched: ${comparison.unmatched.baseStageIds.length} baseline / ${comparison.unmatched.candStageIds.length} candidate, Delta bookkeeping: ${comparison.bookkeepingStageIds.baseStageIds.length} baseline / ${comparison.bookkeepingStageIds.candStageIds.length} candidate`);
  lines.push('');
  lines.push(...renderComparabilitySection(comparison.comparability));
  lines.push('');
  lines.push('### Metric deltas');
  lines.push('');
  for (const m of comparison.metrics) {
    const text = METRIC_TEXT[m.key] ?? String;
    const change = m.delta != null && m.baseline ? m.delta / m.baseline : null;
    const label = m.direction === 'unchanged' ? 'unchanged' : m.withinNoise ? 'within noise' : m.direction;
    lines.push(`- ${m.label}: ${orNa(m.baseline, text)} -> ${orNa(m.candidate, text)} (${[changeText(change), label].filter(Boolean).join(', ')})`);
  }
  lines.push('');
  lines.push(...renderFindingsSection('Introduced findings', comparison.findings.introduced));
  lines.push('');
  lines.push(...renderFindingsSection('Resolved findings', comparison.findings.resolved));
  lines.push('');
  lines.push(...renderChangedSection(comparison.findings.changed));
  return lines.join('\n');
}
