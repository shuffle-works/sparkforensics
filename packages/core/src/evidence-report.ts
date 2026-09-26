// Portable, redacted evidence report. Pure builder over an appModel: runs the detectors,
// then serializes a run summary + findings into a deterministic, byte-stable JSON + Markdown.
// Raw task records are never included (privacy baseline); redaction is opt-in via { redact: true }.
import { analyze, auditConfig } from './analyzer.ts';
import { detectorCatalog } from './detectors.ts';
import { typeTag, formatBytes, formatDuration, IMPACT_BAND_ORDER } from './format-utils.ts';
import { FINDING_NAMES, titleCase } from './finding-names.ts';
import { redactReport } from './redact.ts';
import { formatTaskFailureHeadline, type TaskFailureGroup } from './task-failure.ts';
import { coreFindingActionLabel } from './finding-action-label.ts';
import { matchesFindingFilterCriteria } from './finding-filter-predicate.ts';
import { buildRecommendationRollup, isEligible, isRealFinding, rankFindings, type RollupGroup } from './recommendation-rollup.ts';
import { checkCoverage, isCleanRun } from './check-coverage.ts';
import { getThresholdSummary } from './threshold-summary.ts';
import type {
  AppModel, Finding, EvidenceAvailability, ImpactEstimate, RawWasteFigure, RawWasteUnit, ImpactBand,
} from './types.ts';

export const EVIDENCE_SCHEMA_VERSION: number = 4;

// findingRow always sets id/metric/value/recommendation via `?? null` (never omits the key), and
// buildJson does the same for evidenceAvailability and summary.app.{id,name,sparkVersion}: these
// are genuinely nullable at runtime (AppModel.app is nullable, sparkVersion documents null as an
// "unknown version" sentinel). Kept as `?? null`, not `?? undefined`: JSON.stringify drops
// undefined keys but keeps null, so undefined would silently strip these from the report.
//
// `value` is number|string|null: stageFailed and the configAudit entries put text in Finding.value
// instead of a magnitude, carried through unchanged.
export interface FindingRow {
  id: string | null; type: string; name: string; tag: string; impactBand: 'critical'|'warning'|'info';
  stageId: number | null; metric?: string | null; value?: number | string | null; recommendation?: string | null;
  detectorVersion: number; evidence: Record<string, unknown>;
  // Always present (unlike confidence/validationRequired/docAnchor/impactEstimate): every finding
  // here comes from a real DETECTORS entry, so a label is always computable (falling back to the
  // finding's own `type` as a last resort; see findingRow()).
  actionLabel: string;
  confidence?: string; validationRequired?: string; docAnchor?: string;
  impactEstimate?: ImpactEstimate;
}

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
  impact: string | null;
}

// One line per detector `type` that fired zero findings and could run, so a flat report can state
// "these were checked and came back clean" like the dashboard's clean-checks table.
export interface CleanCheckEntry {
  type: string;
  tag: string;
  thresholdSummary: string;
}

// A detector `type` with zero findings that the log lacked the data to run (the dashboard's "Not
// checked on this log" group), so it is not reported as passed. `reason` says why, naming the
// setting to turn on where the detector gives one.
export interface NotRunCheckEntry extends CleanCheckEntry {
  reason: string;
}

type ImpactBandCounts = { critical: number; warning: number; info: number };

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
  };
  evidenceAvailability: EvidenceAvailability | null;
  detectors: unknown;
  findings: FindingRow[];
  recommendations: RecommendationRow[];
  cleanChecks: CleanCheckEntry[];
  notRunChecks: NotRunCheckEntry[];
}

// Fields surfaced as first-class report columns. Everything else on a finding
// becomes its `evidence` payload (sorted for stable key order).
const CORE_KEYS = new Set([
  'id', 'type', 'name', 'impactBand', 'stageId', 'metric', 'value',
  'recommendation', 'detectorVersion', 'confidence', 'validationRequired', 'docAnchor', 'impactEstimate',
  'actionLabel',
]);

// Internal-only fields with no meaning to a human reading this report: never surfaced as a core
// column, and also excluded from the generic evidence dump (unlike stageIds, which IS actionable
// to a reader). `planNodeIds` is view-layer plan-graph node ids (Plan Advisor detectors, see
// plan-graph-model.ts): on a real log it can carry a hundred-plus ids, which would otherwise print
// as one unreadable `- planNodeIds: [...]` line and bloat the report for no reader benefit.
const NON_EVIDENCE_KEYS = new Set(['planNodeIds']);

function findingRow(f: Finding): FindingRow {
  const evidence: Record<string, unknown> = {};
  for (const k of Object.keys(f).sort()) {
    // An undefined field (spill's spillMagnitude without a magnitude) is absent, as in the JSON.
    const v = (f as Record<string, unknown>)[k];
    if (!CORE_KEYS.has(k) && !NON_EVIDENCE_KEYS.has(k) && v !== undefined) evidence[k] = v;
  }
  const row: FindingRow = {
    id: f.id ?? null,
    type: f.type,
    name: titleCase(FINDING_NAMES[f.type] ?? f.type),
    tag: typeTag(f.type),
    impactBand: f.impactBand,
    stageId: f.stageId ?? null,
    metric: f.metric ?? null,
    value: f.value ?? null,
    recommendation: f.recommendation ?? null,
    detectorVersion: f.detectorVersion ?? 1,
    evidence,
    // Deliberate simplification vs the view layer's REGISTRY fallback: no widget registry here, and
    // falling back to the finding's own `type` is fine since coreFindingActionLabel already covers
    // every emitted type; only obscure/future sub-variants hit this fallback.
    actionLabel: coreFindingActionLabel(f) ?? f.type,
  };
  // Threshold/confidence provenance, only when the detector emitted it.
  if (f.confidence != null) row.confidence = f.confidence;
  if (f.validationRequired != null) row.validationRequired = f.validationRequired;
  if (f.docAnchor != null) row.docAnchor = f.docAnchor;
  if (f.impactEstimate != null) row.impactEstimate = f.impactEstimate;
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
      actionLabel: coreFindingActionLabel(representative) ?? representative.type,
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
      };
    }
    if (group.kind === 'resource') {
      return {
        ...base,
        kind: 'resource',
        unit: group.unit,
        total: group.total,
        impact: formatRawWaste({ value: group.total, unit: group.unit }),
      };
    }
    return {
      ...base,
      kind: 'count',
      byImpactBand: group.byImpactBand,
      // No single quantifiable figure for a count group; the impact-band tally
      // (byImpactBand above) is the payload instead.
      impact: null,
    };
  });
}

// Detector types with no real finding, split into those that passed and those the log could not
// run (the rule the dashboard's Clean checks uses, from check-coverage.ts). Differs from
// Alerts.tsx in one way: the dashboard excludes coreLocality (the one always-mounted reference
// widget, shown elsewhere); a flat report has no such separate surface, so this includes it too.
function buildCheckLists(
  findings: Finding[], stages: AppModel['stages'],
): { cleanChecks: CleanCheckEntry[]; notRunChecks: NotRunCheckEntry[] } {
  // isRealFinding: a type whose only finding is an evidence caveat (memoryUtilization's
  // dataUnavailable variant) had nothing to check, so it lands in notRunChecks.
  const firedTypes = new Set(findings.filter(isRealFinding).map((f) => f.type));
  const coverage = checkCoverage(stages, findings);
  const seen = new Set<string>();
  const cleanChecks: CleanCheckEntry[] = [];
  const notRunChecks: NotRunCheckEntry[] = [];
  // detectorCatalog() can list the same type more than once (configAudit has 4 entries); dedupe by
  // type, keeping first, so a type with sibling entries contributes exactly one line.
  for (const d of detectorCatalog() as Array<{ type: string }>) {
    if (firedTypes.has(d.type) || seen.has(d.type)) continue;
    seen.add(d.type);
    const entry = { type: d.type, tag: typeTag(d.type), thresholdSummary: getThresholdSummary(d.type) };
    const reason = coverage.notRunReason(d.type);
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

// Keyed by appModel object identity: mcp-tools.ts caches one fixed appModel per runId (never
// mutated), so re-running analyze()/auditConfig() reproduces the same catalog. getFindingEvidence
// calls buildEvidenceReport once per drill-down; without this, N lookups meant N detector re-runs.
// A WeakMap needs no invalidation: once mcp-tools.ts evicts the appModel, this entry is collectible.
const jsonCache = new WeakMap<AppModel, EvidenceReportJson>();

function buildJson(appModel: AppModel): EvidenceReportJson {
  const cached = jsonCache.get(appModel);
  if (cached) return cached;
  const { app, stages, executors, sql, jobs, runAggregates, evidenceAvailability } = appModel;
  const catalog = analyze(
    app, stages, executors?.added ?? [], executors?.removed ?? [],
    jobs ?? new Map(), sql ?? new Map(),
    runAggregates ?? null,
  );
  const config = auditConfig(app);
  const allFindings = [...catalog, ...config];
  const rows = sortFindings(allFindings.map(findingRow));
  const recommendations = buildRecommendations(allFindings, stages ?? new Map());
  const { cleanChecks, notRunChecks } = buildCheckLists(allFindings, stages ?? new Map());
  const actionable = allFindings.filter(isEligible);

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
    },
    evidenceAvailability: evidenceAvailability ?? null,
    // Detector metadata so the threshold set that produced each finding travels with the evidence.
    // Order follows DETECTORS (stable) => byte-stable serialization.
    detectors: detectorCatalog(),
    findings: rows,
    recommendations,
    cleanChecks,
    notRunChecks,
  };
  jsonCache.set(appModel, result);
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

function formatWallClockRange(low: number, high: number): string {
  const fmtMs = (ms: number) => (ms === 0 ? '0s' : formatDuration(ms));
  return low === high ? `Estimated ${fmtMs(high)}` : `Estimated ${fmtMs(low)}-${fmtMs(high)}`;
}

function formatRawWaste(rawWaste: RawWasteFigure): string {
  const rounded = Math.round(rawWaste.value * 10) / 10;
  switch (rawWaste.unit) {
    case 'bytes': return formatBytes(rawWaste.value);
    case 'ms': return formatDuration(rawWaste.value);
    case 'mbSeconds': return `${rounded} MB-s`;
    case 'coreHours': return `${rounded.toFixed(1)} core-h`;
    case 'coreMs': return `${rounded} core-ms`;
    default: return String(rawWaste.value);
  }
}

// `basis: 'informational'` findings carry no wallClock/rawWaste at all, so
// there's nothing quantifiable to print; the caller skips the line entirely.
function renderImpactEstimate(estimate: ImpactEstimate): string | null {
  const rangeText = estimate.wallClock ? formatWallClockRange(estimate.wallClock.low, estimate.wallClock.high) : null;
  const wasteText = estimate.rawWaste ? formatRawWaste(estimate.rawWaste) : null;
  if (!rangeText && !wasteText) return null;
  const parts = [rangeText, wasteText].filter((p): p is string => p != null).join(' · ');
  return `${parts} (estimateMethod: ${estimate.estimateMethod})`;
}

function renderMarkdown(json: EvidenceReportJson): string {
  const { summary, findings, evidenceAvailability, detectors, recommendations, cleanChecks, notRunChecks } = json;
  const lines: string[] = [];
  lines.push('# Spark run evidence report');
  lines.push('');
  lines.push(`- Application: ${summary.app.name ?? '(unknown)'} (${summary.app.id ?? 'n/a'})`);
  lines.push(`- Spark version: ${summary.app.sparkVersion ?? 'n/a'}`);
  lines.push(`- Stages: ${summary.stageCount} · Jobs: ${summary.jobCount} · SQL executions: ${summary.sqlExecutionCount}`);
  lines.push(`- Findings: ${summary.findingCount} (critical ${summary.impactBandCounts.critical}, warning ${summary.impactBandCounts.warning}, info ${summary.impactBandCounts.info})`);
  const actionableCounts = summary.actionableImpactBandCounts;
  lines.push(`- Findings to act on: ${summary.actionableFindingCount} (critical ${actionableCounts.critical}, warning ${actionableCounts.warning}, info ${actionableCounts.info})`);
  if (summary.clean) lines.push('- Clean run: no findings, no failed jobs, and every check could run.');
  lines.push('');
  if (recommendations.length > 0) {
    lines.push(`## Fix these first (${recommendations.length})`);
    lines.push('');
    recommendations.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.tag}] ${r.actionLabel}`);
      const detail = r.kind === 'count'
        ? Object.entries(r.byImpactBand ?? {}).map(([impactBand, count]) => `${count} ${impactBand}`).join(', ')
        : r.impact;
      lines.push(`   - ${detail} · ×${r.findingCount} finding(s)`);
    });
    lines.push('');
  }
  lines.push(`## Findings (${findings.length})`);
  lines.push('');
  for (const r of findings) {
    const where = r.stageId != null ? ` (stage ${r.stageId})` : '';
    lines.push(`### ${r.name} · ${r.impactBand}${where}`);
    lines.push(`- action: ${r.actionLabel}`);
    if (r.metric != null) lines.push(`- ${r.metric}: ${r.value}`);
    if (r.recommendation) lines.push(`- ${r.recommendation}`);
    if (r.confidence) lines.push(`- confidence: ${r.confidence}`);
    if (r.validationRequired) lines.push(`- validation: ${r.validationRequired}`);
    const impactText = r.impactEstimate ? renderImpactEstimate(r.impactEstimate) : null;
    if (impactText) lines.push(`- impact: ${impactText}`);
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
      lines.push(`- ${d.type} (v${d.version}, ${d.scope}), thresholds: ${JSON.stringify(d.thresholds)}`);
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
      lines.push(`- [${c.tag}] ${c.type}: ${c.thresholdSummary}`);
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
  return matchesFindingFilterCriteria(row, filter);
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
 *   hides that other checks passed or other fixes exist.
 */
export function buildEvidenceReport(
  appModel: AppModel,
  { redact = false, markdown: computeMarkdown = true, findingsFilter }: {
    redact?: boolean; markdown?: boolean; findingsFilter?: FindingsFilter;
  } = {},
): { markdown: string; json: EvidenceReportJson } {
  let json = buildJson(appModel);
  if (redact) json = redactReport(json);
  // Filter after redact, not before: redaction only replaces string values on surviving rows,
  // never adds/removes rows, so the two orderings produce identical final content.
  if (findingsFilter) json = { ...json, findings: json.findings.filter((row) => matchesFindingsFilter(row, findingsFilter)) };
  const markdown = computeMarkdown ? renderMarkdown(json) : '';
  return { markdown, json };
}
