// Portable, redacted evidence report. Pure builder over an appModel: runs the detectors,
// then serializes a run summary + findings into a deterministic, byte-stable JSON + Markdown.
// Raw task records are never included (privacy baseline); redaction is opt-in via { redact: true }.
import { analyze, auditConfig } from './analyzer.ts';
import type { ThresholdOverrides } from './detectors.ts';
import {
  describeTunedThresholds, tunedDetectorCatalog, tunedDetectors, tunedRunNote, tunedThresholdsForType,
} from './threshold-overrides.ts';
import { getThresholdSummary } from './threshold-summary.ts';
import {
  typeTag, formatBytes, formatCores, formatDuration, formatRawWaste, formatWallClockRange, IMPACT_BAND_ORDER, readsAsZero,
} from './format-utils.ts';
import { findingName, titleCase } from './finding-names.ts';
import { redactReport, redactRunModel } from './redact.ts';
import { formatTaskFailureHeadline, type TaskFailureGroup } from './task-failure.ts';
import { findingActionLabel } from './finding-action-label.ts';
import { matchesFindingFilterCriteria, singleStageId } from './finding-filter-predicate.ts';
import { buildRecommendationRollup, isEligible, isRealFinding, rankFindings, type RollupGroup } from './recommendation-rollup.ts';
import { checkCoverage, isCleanRun } from './check-coverage.ts';
import { buildRunVerdict, stepCopyRecommendation, stepCopyText, type RunVerdictModel } from './run-verdict.ts';
import {
  estimateProvenance, impactEstimateFigure, impactFigure, rawWasteMeaning, savingsMeaning,
} from './impact-format.ts';
import { computeRunShape, type RunShape } from './run-shape.ts';
import { detectorInfoByType } from './detector-docs.ts';
import type {
  AppModel, Finding, FindingEvidenceMap, FindingType, EvidenceAvailability, ImpactEstimate, RawWasteUnit, ImpactBand,
  TunedThresholds,
} from './types.ts';

export const EVIDENCE_SCHEMA_VERSION: number = 5;

// findingRow always sets id/metric/value/recommendation via `?? null` (never omits the key), and
// buildJson does the same for evidenceAvailability and summary.app.{id,name,sparkVersion}: these
// are genuinely nullable at runtime (AppModel.app is nullable, sparkVersion documents null as an
// "unknown version" sentinel). Kept as `?? null`, not `?? undefined`: JSON.stringify drops
// undefined keys but keeps null, so undefined would silently strip these from the report.
//
// `value` is always a magnitude or null. The text-valued findings (stageFailed's failure reason,
// configAudit's current setting, incompleteRun's 'missing') carry theirs in `valueText` instead,
// present only on those rows.
interface FindingRowColumns {
  id: string | null; name: string; tag: string; impactBand: 'critical'|'warning'|'info';
  stageId: number | null; metric?: string | null; value?: number | null; valueText?: string;
  recommendation?: string | null; detectorVersion: number;
  // Always present (unlike confidence/validationRequired/docAnchor/impactEstimate): every finding
  // here comes from a real DETECTORS entry, so a label is always computable (falling back to the
  // finding's own `type` as a last resort; see findingRow()).
  actionLabel: string;
  confidence?: string; validationRequired?: string; docAnchor?: string;
  impactEstimate?: ImpactEstimate;
  // The impactEstimate as the dashboard prints it ("2.0s", "0.1 GB-h"), and what it counts; only
  // when there is a figure to show (none for an informational or zero estimate).
  impact?: string;
  impactMeaning?: string | null;
  // Only on a finding whose detector ran with a user override off its default (CLI/MCP
  // --thresholds): the overridden thresholds. Its impact estimate is uncalibrated.
  tunedThresholds?: TunedThresholds;
}

// One row per finding, discriminated on `type`: `evidence` is that type's public evidence
// (FindingEvidenceMap, projected through EVIDENCE_KEYS below), never the finding's other fields.
export type FindingRow = {
  [T in FindingType]: FindingRowColumns & { type: T; evidence: FindingEvidenceMap[T] };
}[FindingType];

// The `Fix these first` rollup row: one entry per buildRecommendationRollup
// group, so the CLI/MCP/download paths get the same impact-ranked aggregation the dashboard shows.
export interface RecommendationRow {
  type: string;
  tag: string;
  kind: 'time' | 'resource' | 'count';
  actionLabel: string;
  findingCount: number;
  findingIds: string[];
  stageCount?: number;
  recoverableMsHigh?: number;
  unit?: RawWasteUnit;
  total?: number;
  byImpactBand?: Partial<Record<ImpactBand, number>>;
  // The group's savings figure in the dashboard's units ("26.1s", "0.4 GB-h", "12.3 core-s"), or
  // null for a count group or a resource figure that rounds to zero; `impactMeaning` says what it
  // counts ("of run time", "of core time", ...).
  impact: string | null;
  impactMeaning: string | null;
}

// One line per detector `type` that fired zero findings and could run, so a flat report can state
// "these were checked and came back clean" like the dashboard's clean-checks table.
export interface CleanCheckEntry {
  type: string;
  tag: string;
  thresholdSummary: string;
  // Only when the run tuned this type's detector: `thresholdSummary` then reads the tuned values.
  tunedThresholds?: TunedThresholds;
}

// A detector `type` with zero findings that the log lacked the data to run (the dashboard's "Not
// checked on this log" group), so it is not reported as passed. `reason` says why, naming the
// setting to turn on where the detector gives one.
export interface NotRunCheckEntry extends CleanCheckEntry {
  reason: string;
}

type ImpactBandCounts = { critical: number; warning: number; info: number };

// How the run ended, as far as its jobs say (run-outcome.ts, the same summary the dashboard's
// verdict leads with). Counts only jobs with an end record; `failureReason` is the first line of
// Spark's own recorded reason, only when a job failed, and `failureReasonStageId` the stage it came
// from (null when there is no reason or it came from a job's exception).
// One verdict step: a place to look (a stage, or an app-level problem), led by its best-ranked
// finding, with the other finding types flagged there. `text` is the step's line in the
// dashboard's "Copy next steps" checklist.
export interface VerdictStepRow {
  key: string;
  stageId: number | null;
  type: string;
  tag: string;
  leadFindingId: string | null;
  actionLabel: string;
  recommendation: string;
  impact: string | null;
  impactMeaning: string | null;
  relatedTypes: string[];
  text: string;
}

// The dashboard's run verdict (run-verdict.ts): title, summary sentences, the first steps in the
// same order, how many more places the full list holds, and the "Copy next steps" text.
export interface VerdictJson {
  title: string;
  summary: string[];
  steps: VerdictStepRow[];
  remainingPlaces: number;
  copyText: string | null;
}

export interface RunOutcomeSummary {
  failedJobs: number;
  totalJobs: number;
  failureReason: string | null;
  failureReasonStageId: number | null;
}

export interface EvidenceReportJson {
  schemaVersion: number;
  summary: {
    app: { id?: string | null; name?: string | null; sparkVersion?: string | null };
    stageCount: number; jobCount: number; sqlExecutionCount: number;
    // Every row in `findings`, evidence caveats and the run-completeness check included.
    findingCount: number;
    impactBandCounts: ImpactBandCounts;
    // Only the findings the dashboard counts and ranks (top bar, verdict): no evidence caveat and
    // no incompleteRun row.
    actionableFindingCount: number;
    actionableImpactBandCounts: ImpactBandCounts;
    // The dashboard's clean-run rule: no finding at all, no failed job, and every check could run.
    clean: boolean;
    outcome: RunOutcomeSummary;
    runShape: RunShape;
    // Only on a tuned run: every detector an override moved off its defaults, keyed by entry type.
    tunedThresholds?: Record<string, TunedThresholds>;
  };
  verdict: VerdictJson;
  evidenceAvailability: EvidenceAvailability | null;
  detectors: unknown;
  findings: FindingRow[];
  recommendations: RecommendationRow[];
  cleanChecks: CleanCheckEntry[];
  notRunChecks: NotRunCheckEntry[];
}

// Each finding type's public evidence fields: exactly the keys of its FindingEvidenceMap entry
// (finding-types.ts), checked both ways at compile time. A field a detector adds for another core
// module (stageShape's totalCores, utilization's unrounded fraction) is left off both, so it never
// reaches the report; adding, renaming or dropping a key here changes the report contract.
const EVIDENCE_KEYS = {
  skew: [],
  stageShape: ['rule'],
  shuffle: [],
  partitionSizing: ['rule'],
  spill: ['spillMagnitude'],
  gc: ['direction'],
  slowHost: ['variant', 'host', 'hostTaskShare', 'hostMeanMs', 'dimension', 'executorId', 'execMaxValue'],
  stageSlowness: [],
  stageFailed: ['variant', 'numTasks', 'memoryBytesSpilled', 'failedTaskDetails'],
  failures: ['failedTasks', 'dominantReason', 'dominantError', 'failureGroups', 'otherFailedTasks'],
  straggler: ['unit', 'speculativeTasks', 'stragglerCount'],
  speculationWaste: [],
  retryWaste: ['numTasks', 'memoryBytesSpilled', 'retriedTaskDetails'],
  tinyTask: [],
  incompleteRun: [],
  coldStart: [],
  utilization: ['cpuUtilizationPct'],
  memoryUtilization: ['variant', 'rule', 'executorId', 'heap', 'dataUnavailable'],
  cacheUtilization: [
    'variant', 'rddId', 'rddName', 'memorySize', 'diskSize', 'numCachedPartitions', 'numPartitions', 'dataUnavailable',
  ],
  coreLocality: ['nonLocalTaskCount'],
  autoscalingChurn: ['shortLivedExecutorCount'],
  cachingOpportunity: ['variant', 'relation', 'format', 'relations', 'operator', 'executionIds', 'totalReadBytes'],
  jobFailureRate: ['failedJobs', 'totalJobs', 'failedTasks', 'totalTasks', 'avgJobDurationMs', 'taskFailureRate'],
  configAudit: ['property'],
  duplicatePlanSubtree: [
    'executionId', 'stageIds', 'stageShares', 'occurrencesIdentical', 'rootName', 'subtreeSize', 'sampleRelation',
    'groupIndex',
  ],
  smallFiles: ['executionId', 'stageIds', 'fileCount', 'direction', 'nodeName'],
  underBroadcast: ['executionId', 'stageIds', 'largerSideBytes'],
  overBroadcast: ['executionId', 'stageIds'],
} as const satisfies { [T in FindingType]: readonly (keyof FindingEvidenceMap[T])[] };

// The other direction: an evidence field EVIDENCE_KEYS doesn't list fails here.
type UnlistedEvidenceKey = {
  [T in FindingType]: Exclude<keyof FindingEvidenceMap[T], (typeof EVIDENCE_KEYS)[T][number]>;
}[FindingType];
type AssertNever<T extends never> = T;
export type EvidenceKeysComplete = AssertNever<UnlistedEvidenceKey>;

// The finding's evidence, keys sorted for a stable order. An undefined field (spill's
// spillMagnitude without a magnitude) is absent, as in the JSON.
function projectEvidence(f: Finding): Record<string, unknown> {
  const fields = f as unknown as Record<string, unknown>;
  const evidence: Record<string, unknown> = {};
  for (const k of [...EVIDENCE_KEYS[f.type]].sort()) {
    if (fields[k] !== undefined) evidence[k] = fields[k];
  }
  return evidence;
}

function findingRow(f: Finding): FindingRow {
  // Cast: projectEvidence's keys come from EVIDENCE_KEYS[f.type], so `evidence` is that type's
  // FindingEvidenceMap entry, which TypeScript can't correlate with `type` on its own.
  const row = {
    id: f.id ?? null,
    type: f.type,
    name: titleCase(findingName(f.type)),
    tag: typeTag(f.type),
    impactBand: f.impactBand,
    stageId: f.stageId ?? null,
    metric: f.metric ?? null,
    value: f.value ?? null,
    ...(f.valueText != null ? { valueText: f.valueText } : {}),
    recommendation: f.recommendation ?? null,
    detectorVersion: f.detectorVersion ?? 1,
    evidence: projectEvidence(f),
    actionLabel: findingActionLabel(f),
  } as FindingRow;
  // Threshold/confidence provenance, only when the detector emitted it.
  if (f.confidence != null) row.confidence = f.confidence;
  if (f.validationRequired != null) row.validationRequired = f.validationRequired;
  if (f.docAnchor != null) row.docAnchor = f.docAnchor;
  if (f.impactEstimate != null) row.impactEstimate = f.impactEstimate;
  const figure = impactEstimateFigure(f.impactEstimate);
  if (figure) {
    row.impact = figure.text;
    row.impactMeaning = figure.meaning;
  }
  if (f.tunedThresholds != null) row.tunedThresholds = f.tunedThresholds;
  return row;
}

// Deterministic finding order: impact band, then type, then stage, then id, so a fixed appModel
// always serializes byte-for-byte identically.
function sortFindings(rows: FindingRow[]): FindingRow[] {
  return [...rows].sort((a, b) => {
    const s = (IMPACT_BAND_ORDER[a.impactBand] ?? 9) - (IMPACT_BAND_ORDER[b.impactBand] ?? 9);
    if (s !== 0) return s;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    const sa = a.stageId ?? -1;
    const sb = b.stageId ?? -1;
    if (sa !== sb) return sa - sb;
    return (a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0;
  });
}

// isEligible/rankFindings are shared with FixTheseFirst.tsx via recommendation-rollup.ts; this
// file's isEligible call omits FixTheseFirst's REGISTRY check: every finding here already came out
// of analyze()/auditConfig() so it's a known type, and REGISTRY (.tsx) isn't importable here anyway.

// The impact-ranked "highest-leverage fix" rollup, ported from FixTheseFirst.tsx so CLI/MCP/download
// get the same ranking. buildRecommendationRollup already returns groups in the correct cross-group
// order, so this only maps each group to its JSON row without re-sorting.
function buildRecommendations(
  findings: Finding[],
  stages: Map<number, { submittedAt?: number; completedAt?: number }>,
): RecommendationRow[] {
  const eligible = findings.filter(isEligible);
  const groups = buildRecommendationRollup(eligible, stages);
  return groups.map((group: RollupGroup): RecommendationRow => {
    const ranked = rankFindings(group.findings);
    const representative = ranked[0];
    const findingIds = ranked.map((f) => f.id).filter((id): id is string => id != null);
    const base = {
      type: group.type,
      tag: typeTag(group.type),
      actionLabel: findingActionLabel(representative),
      findingCount: group.findingCount,
      findingIds,
    };
    if (group.kind === 'time') {
      return {
        ...base,
        kind: 'time',
        stageCount: group.stageCount,
        recoverableMsHigh: group.recoverableMsHigh,
        // A point estimate, not a range: matches FixTheseFirst.tsx's trailingStat for time groups,
        // which prints the same figure twice rather than the finding-level spread computeStageUnionMs collapsed.
        impact: formatWallClockRange(group.recoverableMsHigh, group.recoverableMsHigh),
        impactMeaning: 'of run time',
      };
    }
    if (group.kind === 'resource') {
      const text = formatRawWaste({ value: group.total, unit: group.unit });
      const shown = readsAsZero(text) ? null : text;
      return {
        ...base,
        kind: 'resource',
        unit: group.unit,
        total: group.total,
        impact: shown,
        impactMeaning: shown ? rawWasteMeaning(group.unit) : null,
      };
    }
    return {
      ...base,
      kind: 'count',
      byImpactBand: group.byImpactBand,
      // No single quantifiable figure for a count group; the impact-band tally
      // (byImpactBand above) is the payload instead.
      impact: null,
      impactMeaning: null,
    };
  });
}

// Finding types with no real finding, split into those that passed and those the log could not
// run (the rule the dashboard's Clean checks uses, from check-coverage.ts). Differs from
// Alerts.tsx in one way: the dashboard excludes coreLocality (the one always-mounted reference
// widget, shown elsewhere); a flat report has no such separate surface, so this includes it too.
function buildCheckLists(
  findings: Finding[], stages: AppModel['stages'], thresholds: ThresholdOverrides | undefined,
): { cleanChecks: CleanCheckEntry[]; notRunChecks: NotRunCheckEntry[] } {
  // isRealFinding: a type whose only finding is an evidence caveat (memoryUtilization's
  // dataUnavailable variant) had nothing to check, so it lands in notRunChecks.
  const firedTypes = new Set<string>(findings.filter(isRealFinding).map((f) => f.type));
  const coverage = checkCoverage(stages, findings);
  const cleanChecks: CleanCheckEntry[] = [];
  const notRunChecks: NotRunCheckEntry[] = [];
  // One line per emitted finding type (configAudit's four entries give one line;
  // broadcastSizing gives overBroadcast and underBroadcast), the same set the dashboard lists.
  for (const [type, { thresholdSummary }] of Object.entries(detectorInfoByType())) {
    if (firedTypes.has(type)) continue;
    // A tuned check was measured against the tuned criterion, so it says which one.
    const tuned = tunedThresholdsForType(type, thresholds);
    const entry: CleanCheckEntry = tuned
      ? { type, tag: typeTag(type), thresholdSummary: getThresholdSummary(type, thresholds), tunedThresholds: tuned }
      : { type, tag: typeTag(type), thresholdSummary };
    const reason = coverage.notRunReason(type);
    if (reason) notRunChecks.push({ ...entry, reason });
    else cleanChecks.push(entry);
  }
  return { cleanChecks, notRunChecks };
}

function countByImpactBand(findings: Array<{ impactBand: string }>): ImpactBandCounts {
  const counts: ImpactBandCounts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) if (f.impactBand in counts) counts[f.impactBand as keyof ImpactBandCounts] += 1;
  return counts;
}

function verdictJson(model: RunVerdictModel): VerdictJson {
  return {
    title: model.title,
    summary: model.summary,
    steps: model.shown.map((step): VerdictStepRow => {
      const recommendation = stepCopyRecommendation(step, model.outcome);
      return {
        key: step.key,
        stageId: step.stageId,
        type: step.lead.type,
        tag: typeTag(step.lead.type),
        leadFindingId: step.lead.id ?? null,
        actionLabel: findingActionLabel(step.lead),
        recommendation,
        impact: impactFigure(step.lead),
        impactMeaning: savingsMeaning(step.lead),
        relatedTypes: step.related.map((f) => f.type),
        text: stepCopyText(step.lead, recommendation, step.stageId),
      };
    }),
    remainingPlaces: model.remaining,
    copyText: model.copyText,
  };
}

// Keyed by appModel object identity: mcp-tools.ts caches one fixed appModel per runId (never
// mutated), so re-running analyze()/auditConfig() reproduces the same catalog. getFindingEvidence
// calls buildEvidenceReport once per drill-down; without this, N lookups meant N detector re-runs.
// A WeakMap needs no invalidation: once mcp-tools.ts evicts the appModel, this entry is collectible.
// Each cache is split first by the overrides object the report ran under (one fixed, frozen object
// per CLI invocation or MCP server process; DEFAULT_THRESHOLDS for the specification's).
type ReportCache = WeakMap<object, WeakMap<AppModel, EvidenceReportJson>>;
const DEFAULT_THRESHOLDS = {};
const jsonCache: ReportCache = new WeakMap();
// The redacted report, keyed by the unredacted appModel it was built from.
const redactedJsonCache: ReportCache = new WeakMap();

function cacheFor(cache: ReportCache, thresholds: ThresholdOverrides | undefined): WeakMap<AppModel, EvidenceReportJson> {
  const key = thresholds ?? DEFAULT_THRESHOLDS;
  let byModel = cache.get(key);
  if (!byModel) {
    byModel = new WeakMap();
    cache.set(key, byModel);
  }
  return byModel;
}

function runFindings(appModel: AppModel, thresholds: ThresholdOverrides | undefined): { catalog: Finding[]; config: Finding[] } {
  const { app, stages, executors, sql, jobs, runAggregates } = appModel;
  const catalog = analyze(
    app, stages, executors?.added ?? [], executors?.removed ?? [],
    jobs ?? new Map(), sql ?? new Map(),
    runAggregates ?? null, { thresholds },
  );
  return { catalog, config: auditConfig(app) };
}

// Redacts the model and findings before the report derives any text from them, the same order
// the HTML export uses: the verdict truncates Spark's failure reason, and redacting that
// truncated copy afterwards would miss an identifier the cut left as a fragment.
function buildRedactedJson(appModel: AppModel, thresholds: ThresholdOverrides | undefined): EvidenceReportJson {
  const cache = cacheFor(redactedJsonCache, thresholds);
  const cached = cache.get(appModel);
  if (cached) return cached;
  const { catalog, config } = runFindings(appModel, thresholds);
  const run = redactRunModel(appModel, catalog, config);
  // redactReport stays as a last pass: idempotent over pseudonyms, and it covers the report's own
  // structured fields (summary.app.id) the same way it always has.
  const result = redactReport(buildJson(run.appModel, thresholds, { catalog: run.catalog, config: run.configFindings }));
  cache.set(appModel, result);
  return result;
}

function buildJson(
  appModel: AppModel, thresholds: ThresholdOverrides | undefined, findings?: { catalog: Finding[]; config: Finding[] },
): EvidenceReportJson {
  const cache = cacheFor(jsonCache, thresholds);
  const cached = cache.get(appModel);
  if (cached) return cached;
  const { app, stages, executors, sql, jobs, evidenceAvailability } = appModel;
  const { catalog, config } = findings ?? runFindings(appModel, thresholds);
  const allFindings = [...catalog, ...config];
  const rows = sortFindings(allFindings.map(findingRow));
  const recommendations = buildRecommendations(allFindings, stages ?? new Map());
  const { cleanChecks, notRunChecks } = buildCheckLists(allFindings, stages ?? new Map(), thresholds);
  const tuned = tunedDetectors(thresholds);
  const actionable = allFindings.filter(isEligible);
  const fullModel: AppModel = {
    ...appModel, stages: stages ?? new Map(), jobs: jobs ?? new Map(), executors: executors ?? { added: [], removed: [] },
  };
  const runVerdict = buildRunVerdict(fullModel, allFindings);
  const runOutcome = runVerdict.outcome;

  const result: EvidenceReportJson = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    summary: {
      app: {
        // `?? null`, not `?? undefined`: JSON.stringify drops undefined keys but keeps null, and
        // sparkVersion's null is a deliberate "unknown/absent" sentinel; undefined would drop these.
        id: app?.id ?? null,
        name: app?.name ?? null,
        sparkVersion: app?.sparkVersion ?? null,
      },
      stageCount: stages?.size ?? 0,
      jobCount: jobs?.size ?? 0,
      sqlExecutionCount: sql?.size ?? 0,
      findingCount: rows.length,
      impactBandCounts: countByImpactBand(rows),
      actionableFindingCount: actionable.length,
      actionableImpactBandCounts: countByImpactBand(actionable),
      clean: isCleanRun({ jobs: jobs ?? new Map(), stages: stages ?? new Map() }, allFindings),
      outcome: {
        failedJobs: runOutcome.failedJobs,
        totalJobs: runOutcome.totalJobs,
        failureReason: runOutcome.reason,
        failureReasonStageId: runOutcome.reason != null ? runOutcome.reasonStageId : null,
      },
      runShape: computeRunShape(fullModel),
      ...(tuned ? { tunedThresholds: tuned } : {}),
    },
    verdict: verdictJson(runVerdict),
    evidenceAvailability: evidenceAvailability ?? null,
    // Detector metadata so the threshold set that produced each finding travels with the evidence.
    // Order follows DETECTORS (stable) => byte-stable serialization.
    detectors: tunedDetectorCatalog(thresholds),
    findings: rows,
    recommendations,
    cleanChecks,
    notRunChecks,
  };
  cache.set(appModel, result);
  return result;
}

// Human-readable rendering of an evidence value. Byte-magnitude keys are humanized; objects/arrays
// serialize compactly so no payload is silently dropped from the Markdown.
function renderEvidenceValue(key: string, value: unknown): string {
  if (typeof value === 'number' && /bytes$/i.test(key)) return formatBytes(value);
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// The `failures` finding's distinct errors: a headline per group, its stack excerpt as an indented
// code block (indented, not fenced, so no excerpt content can close it early).
function renderFailureGroups(groups: TaskFailureGroup[]): string[] {
  const lines = [`  - failureGroups: ${groups.length}`];
  for (const g of groups) {
    lines.push(`    - ${g.count} task(s): ${formatTaskFailureHeadline(g)}`);
    if (g.stackExcerpt) {
      lines.push('');
      for (const l of g.stackExcerpt.split('\n')) lines.push(`          ${l}`);
      lines.push('');
    }
  }
  return lines;
}

// The finding's "Potential savings" figure as the dashboard shows it (impactEstimateFigure: the
// range, or the raw waste only without a range, nothing for a zero or informational estimate),
// followed by what it counts. `basis: 'informational'` findings carry nothing to print.
function renderImpactEstimate(estimate: ImpactEstimate): string | null {
  const figure = impactEstimateFigure(estimate);
  if (!figure) return null;
  return `${figure.text}${figure.meaning ? ` ${figure.meaning}` : ''} (estimateMethod: ${estimate.estimateMethod})`;
}

// The run's job results in one line, worded like the dashboard verdict: failures first, with
// Spark's recorded reason; null when the log records no ended job.
function renderOutcome(outcome: RunOutcomeSummary, incomplete: boolean): string | null {
  const { failedJobs, totalJobs, failureReason, failureReasonStageId } = outcome;
  if (totalJobs === 0) return null;
  if (failedJobs > 0) {
    const failed = failedJobs < totalJobs
      ? `${failedJobs} of ${totalJobs} jobs failed.`
      : totalJobs === 1 ? 'The run\'s one job failed.' : `All ${totalJobs} jobs failed.`;
    if (!failureReason) return failed;
    const where = failureReasonStageId != null ? ` (stage ${failureReasonStageId})` : '';
    return `${failed} Spark's recorded reason${where}: ${failureReason}`;
  }
  const succeeded = totalJobs === 1 ? 'Its one job succeeded.' : `All ${totalJobs} jobs succeeded.`;
  return incomplete ? `${succeeded} The log has no end-of-run record, so jobs still running when it stops are not counted.` : succeeded;
}

// The Scorecard, ETL phases and core-usage figures, each worded to say what it measures, since
// "efficiency" and "unused core time" are different shares. A figure the dashboard cannot show is
// left out.
function renderRunShape(shape: RunShape): string[] {
  const lines: string[] = [];
  if (shape.wallClockMs != null) lines.push(`- Wall-clock: ${formatDuration(shape.wallClockMs)}`);
  if (shape.efficiencyPct != null) lines.push(`- Efficiency: ${shape.efficiencyPct}% (share of the run with a stage running)`);
  if (shape.unusedCoreTimePct != null) {
    lines.push(`- Unused core time: ${shape.unusedCoreTimePct}% (driver idle plus executor slack, as a share of available core time)`);
  }
  if (shape.peakBusyCores != null) lines.push(`- Peak busy cores: ${formatCores(shape.peakBusyCores)}`);
  if (shape.etlPhasesMs) {
    const { extract, transform, load } = shape.etlPhasesMs;
    lines.push(`- ETL phases (summed stage time): extract ${formatDuration(extract)}, transform ${formatDuration(transform)}, load ${formatDuration(load)}`);
  }
  return lines;
}

// The dashboard verdict card as text: title, summary, then the numbered steps worded as its
// "Copy next steps" checklist, each followed by the other finding types flagged at that place.
function renderVerdict(verdict: VerdictJson): string[] {
  const lines = ['## Verdict', '', verdict.title];
  if (verdict.summary.length > 0) lines.push('', verdict.summary.join(' '));
  if (verdict.steps.length > 0) {
    lines.push('');
    verdict.steps.forEach((step, i) => {
      lines.push(`${i + 1}. [${step.tag}] ${step.text}`);
      if (step.relatedTypes.length > 0) {
        const related = step.relatedTypes.map(findingName).join(', ');
        lines.push(`   - Also flagged here: ${related}. These often share this cause, so the same fix may clear them too.`);
      }
    });
    if (verdict.remainingPlaces > 0) {
      const places = `${verdict.remainingPlaces} more place${verdict.remainingPlaces === 1 ? '' : 's'}`;
      lines.push('', `${places} to look at in the Findings section below.`);
    }
  }
  lines.push('');
  return lines;
}

// `incomplete` comes from the unfiltered findings, since a findingsFilter can drop the incompleteRun row.
function renderMarkdown(json: EvidenceReportJson, incomplete: boolean): string {
  const { summary, verdict, findings, evidenceAvailability, detectors, recommendations, cleanChecks, notRunChecks } = json;
  const lines: string[] = [];
  lines.push('# Spark run evidence report');
  lines.push('');
  lines.push(`- Application: ${summary.app.name ?? '(unknown)'} (${summary.app.id ?? 'n/a'})`);
  lines.push(`- Spark version: ${summary.app.sparkVersion ?? 'n/a'}`);
  if (summary.tunedThresholds) lines.push(`- Tuned thresholds: ${tunedRunNote(summary.tunedThresholds)}`);
  lines.push(`- Stages: ${summary.stageCount} · Jobs: ${summary.jobCount} · SQL executions: ${summary.sqlExecutionCount}`);
  lines.push(`- Findings: ${summary.findingCount} (critical ${summary.impactBandCounts.critical}, warning ${summary.impactBandCounts.warning}, info ${summary.impactBandCounts.info})`);
  const actionableCounts = summary.actionableImpactBandCounts;
  lines.push(`- Findings to act on: ${summary.actionableFindingCount} (critical ${actionableCounts.critical}, warning ${actionableCounts.warning}, info ${actionableCounts.info})`);
  const outcomeLine = renderOutcome(summary.outcome, incomplete);
  if (outcomeLine) lines.push(`- Outcome: ${outcomeLine}`);
  if (summary.clean) lines.push('- Clean run: no findings, no failed jobs, and every check could run.');
  lines.push(...renderRunShape(summary.runShape));
  lines.push('');
  lines.push(...renderVerdict(verdict));
  if (recommendations.length > 0) {
    lines.push(`## Fix these first (${recommendations.length})`);
    lines.push('');
    recommendations.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.tag}] ${r.actionLabel}`);
      const detail = r.kind === 'count'
        ? Object.entries(r.byImpactBand ?? {}).map(([impactBand, count]) => `${count} ${impactBand}`).join(', ')
        : r.impact && `${r.impact}${r.impactMeaning ? ` ${r.impactMeaning}` : ''}`;
      lines.push(`   - ${detail ? `${detail} · ` : ''}×${r.findingCount} finding(s)`);
    });
    lines.push('');
  }
  lines.push(`## Findings (${findings.length})`);
  lines.push('');
  for (const r of findings) {
    const where = r.stageId != null ? ` (stage ${r.stageId})` : '';
    lines.push(`### ${r.name} · ${r.impactBand}${where}`);
    lines.push(`- action: ${r.actionLabel}`);
    if (r.metric != null) lines.push(`- ${r.metric}: ${r.valueText ?? r.value}`);
    if (r.recommendation) lines.push(`- ${r.recommendation}`);
    if (r.confidence) lines.push(`- confidence: ${r.confidence}`);
    if (r.validationRequired) lines.push(`- validation: ${r.validationRequired}`);
    if (r.tunedThresholds) lines.push(`- tuned thresholds: ${describeTunedThresholds(r.tunedThresholds)}`);
    const impactText = r.impactEstimate ? renderImpactEstimate(r.impactEstimate) : null;
    if (impactText) lines.push(`- impact: ${impactText}`);
    const provenance = r.impactEstimate ? estimateProvenance(r) : null;
    if (provenance) lines.push(`- estimate: ${provenance}`);
    lines.push(`- detector version: ${r.detectorVersion}`);
    // Evidence payload (sorted for stable order) so two rows differing only by evidence (two
    // smallFiles by direction, two partitionSizing by rule) render distinctly.
    const evidence = Object.entries(r.evidence ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (evidence.length) {
      lines.push('- evidence:');
      for (const [k, v] of evidence) {
        if (k === 'failureGroups' && Array.isArray(v)) lines.push(...renderFailureGroups(v as TaskFailureGroup[]));
        else lines.push(`  - ${k}: ${renderEvidenceValue(k, v)}`);
      }
    }
    lines.push('');
  }
  if (evidenceAvailability?.entries?.length) {
    lines.push('## Evidence availability');
    lines.push('');
    for (const e of evidenceAvailability.entries) {
      lines.push(`- ${e.key}: ${e.state} (${e.summary})`);
    }
    lines.push('');
  }
  // Detector catalog: the version + threshold set that produced each finding, so the Markdown carries provenance too.
  if (Array.isArray(detectors) && detectors.length) {
    lines.push('## Detectors');
    lines.push('');
    for (const d of detectors) {
      const tuned = d.tunedThresholds ? ` (tuned: ${describeTunedThresholds(d.tunedThresholds)})` : '';
      lines.push(`- ${d.type} (v${d.version}, ${d.scope}), thresholds: ${JSON.stringify(d.thresholds)}${tuned}`);
    }
    lines.push('');
  }
  if (notRunChecks.length > 0) {
    lines.push(`## Not checked on this log (${notRunChecks.length})`);
    lines.push('');
    lines.push('The log lacked the data these checks need, so they neither passed nor failed.');
    lines.push('');
    for (const c of notRunChecks) {
      lines.push(`- [${c.tag}] ${c.type}: ${c.reason}`);
    }
    lines.push('');
  }
  if (cleanChecks.length > 0) {
    lines.push(`## Clean checks (${cleanChecks.length})`);
    lines.push('');
    for (const c of cleanChecks) {
      const tuned = c.tunedThresholds ? ` (tuned: ${describeTunedThresholds(c.tunedThresholds)})` : '';
      lines.push(`- [${c.tag}] ${c.type}: ${c.thresholdSummary}${tuned}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface FindingsFilter {
  impactBand?: string[];
  type?: string[];
  stageId?: number;
}

// CLI/MCP-facing filter over FindingRow, delegating to the shared core predicate that also backs
// the dashboard's finding-filter.
function matchesFindingsFilter(row: FindingRow, filter: FindingsFilter): boolean {
  // A sql-scope finding carries its stages in evidence.stageIds, not a stageId column: it matches
  // the one stage it touches, as the dashboard's Stage details lists it.
  const stageIds = 'stageIds' in row.evidence ? row.evidence.stageIds : null;
  return matchesFindingFilterCriteria({ ...row, stageId: singleStageId({ stageId: row.stageId, stageIds }) }, filter);
}

/** Build a FindingsFilter from the three optional CLI/MCP filter dimensions, or undefined when
 * none were passed (the "is anything set" gate before calling buildEvidenceReport). */
export function toFindingsFilter(
  impactBand?: string[], type?: string[], stageId?: number,
): FindingsFilter | undefined {
  return (impactBand || type || stageId !== undefined) ? { impactBand, type, stageId } : undefined;
}

/**
 * Build a portable evidence report from an appModel.
 * @param opts redact=true pseudonymizes app ids / hosts; markdown=false skips the Markdown string;
 *   findingsFilter narrows json.findings (and the Markdown Findings section) only, summary,
 *   recommendations, cleanChecks and notRunChecks stay computed from the full set, so a narrow filter never
 *   hides that other checks passed or other fixes exist. thresholds runs the detectors with a user's
 *   validated overrides (CLI/MCP only) and labels whatever they changed.
 */
export function buildEvidenceReport(
  appModel: AppModel,
  { redact = false, markdown: computeMarkdown = true, findingsFilter, thresholds }: {
    redact?: boolean; markdown?: boolean; findingsFilter?: FindingsFilter; thresholds?: ThresholdOverrides;
  } = {},
): { markdown: string; json: EvidenceReportJson } {
  let json = redact ? buildRedactedJson(appModel, thresholds) : buildJson(appModel, thresholds);
  const incomplete = json.findings.some((row) => row.type === 'incompleteRun');
  // Filter after redact, not before: redaction only replaces string values on surviving rows,
  // never adds/removes rows, so the two orderings produce identical final content.
  if (findingsFilter) json = { ...json, findings: json.findings.filter((row) => matchesFindingsFilter(row, findingsFilter)) };
  const markdown = computeMarkdown ? renderMarkdown(json, incomplete) : '';
  return { markdown, json };
}
