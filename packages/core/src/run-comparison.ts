import { computeWallClock } from './wall-clock.ts';
import { normalizeDetail } from './detectors.ts';
import { normalizeStageName, stageIdentityWith, identityIndexWith, pairEqualCounts } from './stage-identity.ts';
import { computeAllocation } from './allocation.ts';
import { totalExecutorCpuMs, withEarlierAttempts } from './run-totals.ts';
import { captureSnapshot } from './session-snapshot.ts';
import { alignStages, compileNormalizePatterns, COMPARISON_SCHEMA_VERSION, type StageAlignment, type StagePair } from './stage-alignment.ts';
import { tunedRunNote } from './threshold-overrides.ts';
import type { Stage, SparkAppInfo, AppModel, Finding, TunedThresholds } from './types.ts';
import type { SessionSnapshot } from './session-snapshot.ts';
import type { ComparisonVerdictText, VerdictJobOutcome } from './comparison-verdict.ts';
import { isIncompleteRun } from './check-coverage.ts';
import { summarizeRunOutcome } from './run-outcome.ts';

export interface MetricDeltaRow {
  key: string; label: string;
  baseline: number | null; candidate: number | null; delta: number | null;
  direction: 'improvement' | 'regression' | 'unchanged' | 'neutral' | 'unavailable';
  unavailableReason?: string;
}
export interface FindingsDeltaRow {
  rule: string; type: string; impactBand: string; baseCount: number; candCount: number; delta: number; stages: string[];
}
export interface StageSkewRow {
  pairId: string; name: string; baseId: number; candId: number;
  baseline: number | null; candidate: number | null; delta: number | null;
}
export interface CompareRunsResult {
  baselineLabel: string; candidateLabel: string;
  // `insufficient`: neither run recorded any executor run time, so there is nothing to compare.
  confidence: 'ok' | 'low' | 'insufficient'; reason: string | null;
  // Share of stages the old exact matcher (`matchStages`) paired, by count. `runtimeCoverage` is
  // the gate: the share of executor run time that sits in paired stages.
  matchedCoverage: number;
  comparisonSchemaVersion: typeof COMPARISON_SCHEMA_VERSION;
  runtimeCoverage: number | null;
  stagePairs: StagePair[];
  unmatched: StageAlignment['unmatched'];
  replanned: StageAlignment['replanned'];
  bookkeepingStageIds: StageAlignment['bookkeepingStageIds'];
  executionAlignment: StageAlignment['executionAlignment'];
  metrics: MetricDeltaRow[];
  findings: { introduced: FindingsDeltaRow[]; resolved: FindingsDeltaRow[] };
  stageSkew: StageSkewRow[];
  baseStages: Array<{ id: number; name: string; metrics: StageMetricsRow }>;
  candStages: Array<{ id: number; name: string; metrics: StageMetricsRow }>;
  // Each run's job results as its own run verdict counts them, and whether its log lacks an
  // end-of-run record: the comparison verdict leads with failed jobs and never calls a cut-off
  // log's shorter time a speed-up.
  jobOutcomes: { baseline: VerdictJobOutcome; candidate: VerdictJobOutcome };
}

function jobOutcome(snapshot: SessionSnapshot): VerdictJobOutcome {
  const { failedJobs, totalJobs } = summarizeRunOutcome(snapshot.jobs, snapshot.catalog);
  return { failedJobs, totalJobs, incomplete: isIncompleteRun(snapshot.catalog) };
}

export { normalizeStageName };

export function stageIdentity(stage: Stage, snapshot: Pick<SessionSnapshot, 'sql'>): string {
  return stageIdentityWith(stage, snapshot, normalizeDetail);
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

// Volume/count metrics, not cost metrics: more or less input/output data, or
// tasks/executors, isn't inherently better or worse (it may just reflect a
// differently-sized job), unlike wall-clock, spill, GC, etc. Exported as the
// single source of truth for "which metrics have no better/worse direction",
// shared by the view (RunComparison.tsx, for Δ coloring) and by
// src/cli/budgets.ts's checkRegression (so a `--regression-metric inputBytes`
// budget can't misread "processed more data" as a regression).
export const NEUTRAL_METRIC_KEYS: ReadonlySet<string> = new Set(['inputBytes', 'outputBytes', 'taskCount', 'executorsAdded']);

function direction(key: string, baseline: number | null, candidate: number | null): MetricDeltaRow['direction'] {
  if (baseline == null || candidate == null) return 'unavailable';
  if (NEUTRAL_METRIC_KEYS.has(key)) return candidate === baseline ? 'unchanged' : 'neutral';
  const d = candidate - baseline;
  return d < 0 ? 'improvement' : d > 0 ? 'regression' : 'unchanged';
}

function metric(
  key: string, label: string, baseline: number | null, candidate: number | null,
  extra: { unavailableReason?: string } = {},
): MetricDeltaRow {
  const dir = direction(key, baseline, candidate);
  const delta = baseline == null || candidate == null ? null : candidate - baseline;
  return { key, label, baseline, candidate, delta, direction: dir, ...extra };
}

export function metricDeltas(baseSnap: SessionSnapshot, candSnap: SessionSnapshot): MetricDeltaRow[] {
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

// Finding categories are counted, not matched: a (rule × impact band) tally needs
// no cross-run stage identity, so it stays correct even when almost no stages
// match uniquely (the common case on real logs, see plan rationale). A
// category the candidate has more of is "introduced"; fewer, "resolved".
export function findingsDelta(baseSnap: SessionSnapshot, candSnap: SessionSnapshot): {
  introduced: FindingsDeltaRow[]; resolved: FindingsDeltaRow[];
} {
  interface TallyEntry { rule: string; type: string; impactBand: string; count: number; stages: Set<string>; }
  const tally = (snap: SessionSnapshot): Map<string, TallyEntry> => {
    const m = new Map<string, TallyEntry>(); // `${rule}§${impactBand}` -> { rule, impactBand, count, stages:Set }
    for (const f of snap.catalog) {
      const rule = 'rule' in f && typeof f.rule === 'string' ? f.rule : f.type;
      const impactBand = f.impactBand ?? 'unknown';
      const key = `${rule}§${impactBand}`;
      const e = m.get(key) ?? { rule, type: f.type, impactBand, count: 0, stages: new Set<string>() };
      e.count++;
      // Resolve stageId → name on this snapshot only: a single-side lookup, so
      // it needs no cross-run identity. App-level findings (stageId null) add none.
      const stage = f.stageId != null ? snap.stages.get(f.stageId) : null;
      if (stage?.name) e.stages.add(stage.name);
      m.set(key, e);
    }
    return m;
  };
  const b = tally(baseSnap), c = tally(candSnap);
  const introduced: FindingsDeltaRow[] = [], resolved: FindingsDeltaRow[] = [];
  for (const key of [...new Set([...b.keys(), ...c.keys()])].sort()) {
    const be = b.get(key), ce = c.get(key);
    const baseCount = be?.count ?? 0;
    const candCount = ce?.count ?? 0;
    if (candCount === baseCount) continue;
    const meta = ce ?? be!;
    const more = candCount > baseCount ? ce! : be!; // the side with more supplies the labels
    const row: FindingsDeltaRow = { rule: meta.rule, type: meta.type, impactBand: meta.impactBand, baseCount, candCount,
      delta: candCount - baseCount, stages: [...more.stages].sort() };
    (candCount > baseCount ? introduced : resolved).push(row);
  }
  return { introduced, resolved };
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
   * output directory no longer splits a stage in two. Findings and `stageIdentity` never see them.
   * Invalid, over-long or empty-matching patterns throw (see `compileNormalizePatterns`). */
  normalizePath?: readonly string[];
}

// Wraps the analyze()-to-compareRuns() snapshot-building sequence shared by
// the CLI's --baseline path and mcp-tools.ts's compareRuns tool: both need
// captureSnapshot (with an empty taskDataCache, the interactive drill-down
// cache, never read by compareRuns/matchStages/metricDeltas/findingsDelta)
// for each side before diffing them.
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
  // The old exact matcher stays the source of `matchedCoverage`; pairs and the gate come from the aligner.
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
  return {
    baselineLabel: baseline.label, candidateLabel: candidate.label,
    confidence,
    reason,
    matchedCoverage: match.coverage,
    comparisonSchemaVersion: COMPARISON_SCHEMA_VERSION,
    runtimeCoverage,
    stagePairs: alignment.pairs,
    unmatched: alignment.unmatched,
    replanned: alignment.replanned,
    bookkeepingStageIds: alignment.bookkeepingStageIds,
    executionAlignment: alignment.executionAlignment,
    metrics: metricDeltas(baseSnap, candSnap),
    findings: findingsDelta(baseSnap, candSnap),
    stageSkew: stageSkewDeltas(baseSnap, candSnap, alignment.pairs),
    baseStages: stageList(baseSnap),
    candStages: stageList(candSnap),
    jobOutcomes: { baseline: jobOutcome(baseSnap), candidate: jobOutcome(candSnap) },
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
      lines.push(`Baseline: ${comparison.baselineLabel} · Candidate: ${comparison.candidateLabel}`, '');
    }
    lines.push(verdict.title);
    if (verdict.sentences.length > 0) lines.push('', verdict.sentences.join(' '));
    lines.push('');
  }
  if (comparison.confidence !== 'ok') {
    lines.push(`- confidence: ${comparison.confidence}, ${comparison.reason}`);
    lines.push('');
  }
  lines.push(`- matched stage coverage: ${(comparison.matchedCoverage * 100).toFixed(1)}%`);
  lines.push(`- runtime coverage: ${comparison.runtimeCoverage === null ? 'n/a' : `${(comparison.runtimeCoverage * 100).toFixed(1)}%`}`);
  lines.push(`- stage pairs: ${comparison.stagePairs.length}, unmatched: ${comparison.unmatched.baseStageIds.length} baseline / ${comparison.unmatched.candStageIds.length} candidate, Delta bookkeeping: ${comparison.bookkeepingStageIds.baseStageIds.length} baseline / ${comparison.bookkeepingStageIds.candStageIds.length} candidate`);
  lines.push('');
  lines.push('### Metric deltas');
  lines.push('');
  for (const m of comparison.metrics) {
    lines.push(`- ${m.label}: ${m.baseline ?? 'n/a'} -> ${m.candidate ?? 'n/a'} (${m.direction})`);
  }
  lines.push('');
  lines.push(...renderFindingsSection('Introduced findings', comparison.findings.introduced));
  lines.push('');
  lines.push(...renderFindingsSection('Resolved findings', comparison.findings.resolved));
  return lines.join('\n');
}
