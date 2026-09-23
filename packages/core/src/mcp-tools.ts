import { resolve as resolvePath, join, dirname } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { collectRun } from './cli/collect-run.ts';
import { deriveEvidenceAvailability } from './evidence-availability.ts';
import { resolveFromShs, DEFAULT_MAX_ARCHIVE_BYTES, DEFAULT_IDLE_TIMEOUT_MS } from './shs-load.ts';
import { mcpError } from './mcp-error.ts';
import { buildEvidenceReport, toFindingsFilter, type FindingRow, type RecommendationRow, type CleanCheckEntry, type EvidenceReportJson } from './evidence-report.ts';
import { redactAppIdentity, redactComparison } from './redact.ts';
import { computeWallClock } from './wall-clock.ts';
import { analyze } from './analyzer.ts';
import { buildComparison, renderComparisonMarkdown, type CompareRunsResult } from './run-comparison.ts';
import { evaluateBudgets, type BudgetsConfig, type BudgetResult } from './cli/budgets.ts';
import { FINDING_NAMES, titleCase } from './finding-names.ts';
import { docAnchorForType, tuningDocSlugForAnchor, pageForAnchor } from './docs-config.ts';
import { typeTag } from './format-utils.ts';
import type { AppModel, Finding, SparkAppInfo } from './types.ts';

export type RunSource = { path: string } | { shsBaseUrl: string; appId: string; attemptId?: string };
// RunRef uses a nested `source` key, matching every real call site (resolveOrCreateRun's
// destructuring, both mcp-server-factory.ts sites, and the tests all pass a nested `source`,
// never flattened path/shsBaseUrl).
export type RunRef = { runId?: string; source?: RunSource };
export interface RunSummary {
  runId: string;
  // string | null (not undefined): getRunSummary always sets these via `?? null`, never omits them.
  app: { id: string | null; name: string | null; sparkVersion: string | null };
  stageCount: number; jobCount: number; sqlExecutionCount: number;
  executorCount: { added: number; removed: number };
  durationMs: number | null;
  // True only when the log recorded a SparkListenerApplicationEnd (app.endTime != null). A caller
  // checking only durationMs:null couldn't tell an incomplete capture from a zero-length run; this
  // is the explicit signal (mirrors the incompleteRun finding).
  runComplete: boolean;
}
// compareRuns returns a smaller MCP-facing projection of CompareRunsResult
// (runIdA/runIdB/findingsDelta/metricDeltas/confidence/reason/matchedCoverage), not the full raw
// shape (no baselineLabel/stageSkew/baseStages/candStages).
export interface McpCompareRunsResult {
  runIdA: string;
  runIdB: string;
  findingsDelta: CompareRunsResult['findings'];
  metricDeltas: CompareRunsResult['metrics'];
  confidence: CompareRunsResult['confidence'];
  reason: CompareRunsResult['reason'];
  matchedCoverage: CompareRunsResult['matchedCoverage'];
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// touch() below does a full Map delete+re-insert per cache hit to maintain LRU order: O(n) per
// touch, fine at this small cap but worth re-checking if the cap is raised significantly.
const CACHE_CAP = envInt('SPARKFORENSICS_MCP_CACHE_CAP', 8);
const CACHE_TTL_MS = envInt('SPARKFORENSICS_MCP_CACHE_TTL_MS', 15 * 60 * 1000);

interface CacheEntry { appModel: AppModel; cacheKey: string; lastAccess: number }

const byRunId = new Map<string, CacheEntry>();   // runId -> { appModel, cacheKey, lastAccess }
const byCacheKey = new Map<string, string>(); // cacheKey -> runId
const pendingByCacheKey = new Map<string, Promise<{ runId: string; appModel: AppModel }>>(); // cacheKey -> in-flight Promise<{runId, appModel}>

export function pathCacheKey(path: string): string {
  const resolved = resolvePath(path);
  if (!existsSync(resolved)) throw mcpError('invalid-event-log', `No such file: ${resolved}`);
  // Size narrows a same-millisecond mtime collision; ctime narrows the case where a copy tool
  // (rsync --preserve-times, tar) restores an identical mtime+size for different content: ctime
  // can't be set by the copying tool, so it still reflects when the file landed on disk.
  const { mtimeMs, ctimeMs, size } = statSync(resolved);
  return `path:${resolved}:${mtimeMs}:${ctimeMs}:${size}`;
}

function shsCacheKey({ shsBaseUrl, appId, attemptId }: { shsBaseUrl: string; appId: string; attemptId?: string }): string {
  return `shs:${shsBaseUrl}:${appId}:${attemptId ?? ''}`;
}

function touch(runId: string): void {
  const entry = byRunId.get(runId);
  // Defensive only for type-narrowing: every call site touches a runId already confirmed present.
  if (!entry) return;
  byRunId.delete(runId);
  entry.lastAccess = Date.now();
  byRunId.set(runId, entry);
}

function deleteRunEntry(id: string, entry: CacheEntry): void {
  byRunId.delete(id);
  if (byCacheKey.get(entry.cacheKey) === id) byCacheKey.delete(entry.cacheKey);
}

function evictStale(): void {
  const now = Date.now();
  for (const [id, entry] of byRunId) {
    if (now - entry.lastAccess > CACHE_TTL_MS) {
      deleteRunEntry(id, entry);
    }
  }
}

function evictOverflow(): void {
  while (byRunId.size > CACHE_CAP) {
    const oldestId = byRunId.keys().next().value;
    // Defensive only for type-narrowing: the while condition guarantees byRunId is non-empty here.
    if (oldestId === undefined) break;
    const entry = byRunId.get(oldestId);
    if (entry) deleteRunEntry(oldestId, entry);
  }
}

export function getCachedAppModel(runId: string): AppModel {
  evictStale();
  const entry = byRunId.get(runId);
  if (!entry) throw mcpError('run-not-found', `No cached run for runId ${runId}.`);
  touch(runId);
  return entry.appModel;
}

async function resolveFromPath(path: string): Promise<AppModel> {
  const { appModel, skippedLines } = await collectRun(path);
  appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
  return appModel;
}

export async function resolveOrCreateRun(
  { source, runId }: RunRef = {},
  { fetchImpl = fetch, maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS }:
    { fetchImpl?: typeof fetch; maxArchiveBytes?: number; idleTimeoutMs?: number } = {},
): Promise<{ runId: string; appModel: AppModel }> {
  evictStale();
  if (runId) {
    return { runId, appModel: getCachedAppModel(runId) };
  }
  if (!source) throw mcpError('access-or-upstream-failure', 'Provide either source or runId.');

  // `'path' in source`, not `source.path`: RunSource's two variants share no common property, so a
  // plain `.path` access doesn't type-check on the union. Equivalent at runtime for every real caller.
  const cacheKey = 'path' in source ? pathCacheKey(source.path) : shsCacheKey(source);
  const cached = byCacheKey.get(cacheKey);
  if (cached && byRunId.has(cached)) {
    touch(cached);
    return { runId: cached, appModel: byRunId.get(cached)!.appModel };
  }

  // Concurrent calls for the same not-yet-cached source must await one shared parse, not each race
  // to insert its own entry: otherwise every racer's insert after the first is orphaned (unreachable
  // via cacheKey, wasting a cache slot until TTL/overflow).
  const pending = pendingByCacheKey.get(cacheKey);
  if (pending) return pending;

  const resolution = (async () => {
    try {
      const appModel = 'path' in source
        ? await resolveFromPath(source.path)
        : (await resolveFromShs(source.shsBaseUrl, source.appId, source.attemptId, { fetchImpl, maxArchiveBytes, idleTimeoutMs })).appModel;

      const newRunId = randomUUID();
      byRunId.set(newRunId, { appModel, cacheKey, lastAccess: Date.now() });
      byCacheKey.set(cacheKey, newRunId);
      evictOverflow();
      return { runId: newRunId, appModel };
    } finally {
      pendingByCacheKey.delete(cacheKey);
    }
  })();
  pendingByCacheKey.set(cacheKey, resolution);
  return resolution;
}

export function diagnoseRun(runId: string, opts?: {
  redact?: boolean; include?: Array<'summary' | 'evidenceAvailability' | 'detectors'>; markdown?: boolean;
  impactBand?: string[]; type?: string[]; stageId?: number;
}): {
  runId: string; findings: FindingRow[]; runComplete: boolean;
  recommendations: RecommendationRow[]; cleanChecks: CleanCheckEntry[];
} & Partial<Pick<EvidenceReportJson, 'summary' | 'evidenceAvailability' | 'detectors'>> & { markdown?: string } {
  const appModel = getCachedAppModel(runId);
  const findingsFilter = toFindingsFilter(opts?.impactBand, opts?.type, opts?.stageId);
  const { json, markdown } = buildEvidenceReport(appModel, { redact: opts?.redact, markdown: opts?.markdown, findingsFilter });
  const include = opts?.include ?? [];
  return {
    runId, findings: json.findings, recommendations: json.recommendations, cleanChecks: json.cleanChecks,
    runComplete: appModel.app?.endTime != null,
    ...(include.includes('summary') ? { summary: json.summary } : {}),
    ...(include.includes('evidenceAvailability') ? { evidenceAvailability: json.evidenceAvailability } : {}),
    ...(include.includes('detectors') ? { detectors: json.detectors } : {}),
    ...(opts?.markdown ? { markdown } : {}),
  };
}

const DOCS_CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'docs-content');

// Both vendored corpora lead with their own heading line; strips the leading '#'/'###' markers, an
// optional `` `TAG`: `` prefix (the detection doc's heading shape), and a trailing `{#anchor}`,
// leaving just the human title. The tuning doc's plain `# Title` heading passes through as no-ops.
function extractDocTitle(markdown: string): string {
  const firstLine = markdown.split('\n', 1)[0] ?? '';
  return firstLine
    .replace(/^#+\s*/, '')
    .replace(/`[A-Z]+`:\s*/, '')
    .replace(/\s*\{#[a-z0-9-]+\}\s*$/, '')
    .trim();
}

export interface FindingDocumentation {
  type: string;
  name: string;
  detectionDoc: { tag: string; title: string; content: string };
  tuningDoc: { anchor: string; title: string; content: string } | null;
}

/** Detection + tuning reference documentation for one finding `type`, independent of any run
 * (documentation is a property of the type: a client fetches it once per type and caches it). */
export function getFindingDocumentation(type: string): FindingDocumentation {
  const label = FINDING_NAMES[type];
  if (label === undefined) throw mcpError('invalid-type', `Unknown finding type: ${type}`);

  const tag = typeTag(type);
  const detectionContent = readFileSync(join(DOCS_CONTENT_DIR, 'detection', `${tag.toLowerCase()}.md`), 'utf8');
  const detectionDoc = { tag, title: extractDocTitle(detectionContent), content: detectionContent };

  const anchor = docAnchorForType(type);
  const slug = anchor ? tuningDocSlugForAnchor(anchor) : null;
  const tuningPath = slug ? join(DOCS_CONTENT_DIR, 'tuning', `${slug}.md`) : null;
  let tuningDoc: FindingDocumentation['tuningDoc'] = null;
  if (tuningPath && anchor && existsSync(tuningPath)) {
    const tuningContent = readFileSync(tuningPath, 'utf8');
    tuningDoc = { anchor, title: extractDocTitle(tuningContent), content: tuningContent };
  } else if (anchor && !slug) {
    // A section hosted on a chapter page (e.g. autoscaling churn on cluster-config): return the
    // owning chapter, the same page the web view's docs link opens.
    const entry = findNavEntry(pageForAnchor(anchor.replace(/^#/, '')));
    if (entry) tuningDoc = { anchor, title: entry.title, content: readNavEntryContent(entry) };
  }

  return { type, name: titleCase(label), detectionDoc, tuningDoc };
}

const CHAPTERS_NAV_FILE = join(DOCS_CONTENT_DIR, 'chapters', 'nav-index.json');

interface NavEntry { anchor: string; title: string; store: string; slug: string; }

function findNavEntry(page: string): NavEntry | undefined {
  const nav = JSON.parse(readFileSync(CHAPTERS_NAV_FILE, 'utf8')) as NavEntry[];
  return nav.find((e) => e.anchor === page);
}

function readNavEntryContent(entry: NavEntry): string {
  const dir = entry.store === 'tuning' ? 'tuning' : 'chapters';
  return readFileSync(join(DOCS_CONTENT_DIR, dir, `${entry.slug}.md`), 'utf8');
}

export interface ReferenceDoc { anchor: string; title: string; content: string; }

/** Full tuning-reference markdown for one doc anchor, run-independent. Resolves the anchor to its
 * owning page via pageForAnchor (so '#metric-task-duration' returns the 'metrics' page), looks it up
 * in the committed nav-index, and reads the markdown from the same docs-content store the website
 * renders from. The general-chapter counterpart to getFindingDocumentation (keyed by finding type). */
export function getReferenceDoc(anchor: string): ReferenceDoc {
  const page = pageForAnchor(String(anchor).replace(/^#/, ''));
  const entry = findNavEntry(page);
  if (!entry) throw mcpError('invalid-anchor', `Unknown reference anchor: ${anchor}`);
  return { anchor: page, title: entry.title, content: readNavEntryContent(entry) };
}

export function getFindingEvidence(
  runId: string, findingId: string, opts?: { redact?: boolean },
): { runId: string; finding: FindingRow } {
  const appModel = getCachedAppModel(runId);
  const { json } = buildEvidenceReport(appModel, { redact: opts?.redact, markdown: false });
  const finding = json.findings.find((f) => f.id === findingId);
  if (!finding) throw mcpError('finding-not-found', `No finding ${findingId} on run ${runId}.`);
  return { runId, finding };
}

function hasCompleteInterval(app: SparkAppInfo | null): boolean {
  return Number.isFinite(app?.startTime) && Number.isFinite(app?.endTime) && (app?.endTime ?? 0) > (app?.startTime ?? 0);
}

export function getRunSummary(runId: string, opts?: { redact?: boolean }): RunSummary {
  const appModel = getCachedAppModel(runId);
  const { app, stages, jobs, sql, executors } = appModel;
  const durationMs = hasCompleteInterval(app) ? computeWallClock(app, stages).total : null;
  // No buildEvidenceReport call here to redact, so reuse redact.ts's app-id + host-token
  // pseudonymization directly. Passing name/sparkVersion (not just id) matters: app.name is free
  // text and can itself carry a host/IP token.
  const rawApp = { id: app?.id ?? null, name: app?.name ?? null, sparkVersion: app?.sparkVersion ?? null };
  const redactedApp = opts?.redact ? redactAppIdentity(rawApp) : rawApp;
  return {
    runId,
    app: redactedApp,
    stageCount: stages.size,
    jobCount: jobs.size,
    sqlExecutionCount: sql.size,
    executorCount: { added: executors.added.length, removed: executors.removed.length },
    durationMs,
    runComplete: app?.endTime != null,
  };
}

// Shared by compareRuns and evaluateBudgetsForRun: both need a resolved run's finding catalog
// (same analyze() call shape) first.
async function resolveAndAnalyze(ref: RunRef): Promise<{ runId: string; appModel: AppModel; catalog: Finding[] }> {
  const { runId, appModel } = await resolveOrCreateRun(ref);
  const catalog = analyze(
    appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
    appModel.jobs, appModel.sql, appModel.runAggregates,
  );
  return { runId, appModel, catalog };
}

export async function compareRuns(
  a: RunRef, b: RunRef, opts?: { redact?: boolean; markdown?: boolean },
): Promise<McpCompareRunsResult & { markdown?: string }> {
  const [
    { runId: runIdA, appModel: appModelA, catalog: catalogA },
    { runId: runIdB, appModel: appModelB, catalog: catalogB },
  ] = await Promise.all([resolveAndAnalyze(a), resolveAndAnalyze(b)]);

  // buildComparison's captureSnapshot uses an empty taskDataCache: that arg only feeds the
  // interactive stage-detail drill-down, which none of compare/matchStages/metricDeltas/findingsDelta
  // read. Findings/metrics come from `catalog` and appModel.stages/sql, both fully populated. Produces
  // identical output to the dashboard; the MCP tool just never exposes per-task drill-down.
  const built = buildComparison(
    { label: runIdA, appModel: appModelA, catalog: catalogA },
    { label: runIdB, appModel: appModelB, catalog: catalogB },
  );
  // Stage names throughout `built` carry raw Spark stage text, which can embed a host/IP token as
  // free text, the same residual redactReport() already scrubs from the evidence report.
  const result = opts?.redact ? redactComparison(built) : built;

  return {
    runIdA,
    runIdB,
    findingsDelta: result.findings,
    metricDeltas: result.metrics,
    confidence: result.confidence,
    reason: result.reason,
    matchedCoverage: result.matchedCoverage,
    ...(opts?.markdown ? { markdown: renderComparisonMarkdown(result) } : {}),
  };
}

export async function evaluateBudgetsForRun(
  primary: RunRef,
  budgets: BudgetsConfig,
  secondary?: RunRef,
): Promise<{ runId: string; results: BudgetResult[]; violated: boolean; inconclusive: boolean }> {
  // Mirrors the CLI's --regression-metric/--max-regression-pct pairing guard: unlike the CLI, this
  // tool never defaults regressionMetric, so seeing it set here means the caller asked for a
  // regression check and forgot the threshold, evaluateBudgets() would otherwise skip it silently.
  if (budgets.regressionMetric !== undefined && budgets.maxRegressionPct === undefined) {
    throw mcpError('access-or-upstream-failure', 'regressionMetric requires maxRegressionPct.');
  }
  const [{ runId, appModel, catalog }, second] = await Promise.all([
    resolveAndAnalyze(primary),
    secondary ? resolveAndAnalyze(secondary) : Promise.resolve(undefined),
  ]);

  let comparison: CompareRunsResult | undefined;
  if (second) {
    comparison = buildComparison(
      { label: runId, appModel, catalog },
      { label: second.runId, appModel: second.appModel, catalog: second.catalog },
    );
  }

  const { results, violated, inconclusive } = evaluateBudgets({ appModel, catalog, budgets, comparison });

  return { runId, results, violated, inconclusive };
}
