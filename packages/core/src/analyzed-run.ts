// The analyzed run: one value that holds everything known about a parsed log. `analyzeRun` builds
// it once, and every surface (dashboard, CLI, MCP, HTML export) takes it from there. The model
// carries the parse gaps (`skippedLines`, `unreadableSqlExecutions`) and the evidence ledger, so
// those live in one place. `run-serialization.ts` turns a run into plain data and back.
import { analyze, auditConfig } from './analyzer.ts';
import type { ThresholdOverrides } from './detectors.ts';
import { deriveEvidenceAvailability } from './evidence-availability.ts';
import { interpretRun, type RunInterpretation } from './run-interpretation.ts';
import type { AppModel, Finding, StageId, TaskData } from './types.ts';

/** Where a run's per-task detail comes from. A live parse keeps its worker, a restored run holds
 * the stages it prefetched, and a run read from an export or a CLI/MCP load has none. */
export type TaskDataSource =
  | { kind: 'worker'; request: (stageId: StageId) => Promise<TaskData> }
  | { kind: 'snapshot'; stages: ReadonlyMap<StageId, TaskData> }
  | { kind: 'none' };

export const NO_TASK_DATA: TaskDataSource = { kind: 'none' };

export interface AnalyzedRun {
  /** The parsed model, with the evidence ledger and the parse gaps set. */
  appModel: AppModel;
  /** The detector findings, worst band first. */
  catalog: Finding[];
  /** The configuration audit's findings. */
  configFindings: Finding[];
  /** Every conclusion about the run, referring to the findings above by id. */
  interpretation: RunInterpretation;
  taskData: TaskDataSource;
}

// Keyed by appModel object identity: mcp-tools.ts caches one fixed appModel per runId (never
// mutated), so re-running analyze()/auditConfig() reproduces the same catalog. getFindingEvidence
// calls buildEvidenceReport once per drill-down; the cache spares each lookup a detector re-run.
// A WeakMap needs no invalidation: once mcp-tools.ts evicts the appModel, this entry is collectible.
// Each cache is split first by the overrides object the report ran under (one fixed, frozen object
// per CLI invocation or MCP server process; DEFAULT_THRESHOLDS for the specification's).
export type ReportCache<T> = WeakMap<object, WeakMap<AppModel, T>>;
const DEFAULT_THRESHOLDS = {};

export function cacheFor<T>(cache: ReportCache<T>, thresholds: ThresholdOverrides | undefined): WeakMap<AppModel, T> {
  const key = thresholds ?? DEFAULT_THRESHOLDS;
  let byModel = cache.get(key);
  if (!byModel) {
    byModel = new WeakMap();
    cache.set(key, byModel);
  }
  return byModel;
}

const findingsCache: ReportCache<{ catalog: Finding[]; config: Finding[] }> = new WeakMap();

/** The run's detector catalog and config audit, computed once per run model and overrides so the
 * report and the blocks built beside it (run-output.ts) share the analysis `analyzeRun` ran. */
export function runFindings(appModel: AppModel, thresholds: ThresholdOverrides | undefined): { catalog: Finding[]; config: Finding[] } {
  const cache = cacheFor(findingsCache, thresholds);
  const cached = cache.get(appModel);
  if (cached) return cached;
  const { app, stages, executors, sql, jobs, runAggregates } = appModel;
  const catalog = analyze(
    app, stages, executors?.added ?? [], executors?.removed ?? [],
    jobs ?? new Map(), sql ?? new Map(),
    runAggregates ?? null, { thresholds },
  );
  const result = { catalog, config: auditConfig(app, stages) };
  cache.set(appModel, result);
  return result;
}

export interface AnalyzeRunOptions {
  /** Detector threshold overrides; the specification's defaults without them. */
  thresholds?: ThresholdOverrides;
  taskData?: TaskDataSource;
}

/** Runs every analysis step on a parsed model and returns the run. The model is not changed: the
 * run holds a copy that carries the evidence ledger, derived from the parse gaps `parsed` records. */
export function analyzeRun(parsed: AppModel, { thresholds, taskData = NO_TASK_DATA }: AnalyzeRunOptions = {}): AnalyzedRun {
  const skippedLines = parsed.skippedLines ?? 0;
  const appModel: AppModel = {
    ...parsed,
    skippedLines,
    evidenceAvailability: deriveEvidenceAvailability(parsed, { skippedLines }),
  };
  const { catalog, config } = runFindings(appModel, thresholds);
  return { appModel, catalog, configFindings: config, interpretation: interpretRun(appModel, catalog, config), taskData };
}
