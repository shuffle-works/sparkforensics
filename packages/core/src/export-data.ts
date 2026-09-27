import type {
  AppModel, Finding, SparkAppInfo, Stage, Job, SqlExecution,
  ExecutorAddedEvent, ExecutorRemovedEvent, RunAggregates, EvidenceAvailability,
} from './types.ts';
import type { RunInterpretation } from './run-interpretation.ts';

/** Version 2 carries the interpretation layer (`interpretation`) and `provenance`. The export bundle renders only the version it was built for and refuses any
 * other, since an older payload lacks the conclusions it would otherwise have to derive. */
export const EXPORT_DATA_SCHEMA_VERSION = 2;

/** @sparkforensics/core's own version (packages/core/package.json, which a test keeps in sync).
 * A constant, not a JSON import, because the vendored copies in cli/mcp/server ship without
 * that package.json. */
export const CORE_VERSION = '0.1.0';

/** What produced an export, shown in the exported dashboard's footer. */
export interface ExportProvenance {
  coreVersion: string;
  /** Content hash of the core sources that ran the analysis (`coreSourceHash`), or 'dev' when
   * the producer could not compute one. */
  buildId: string;
  /** The tool that wrote the file, e.g. "sparkforensics-analyze 0.25.0". */
  producer: string;
}

export interface ExportRunData {
  schemaVersion: number;
  provenance: ExportProvenance;
  app: SparkAppInfo | null;
  stages: Stage[];
  jobs: Job[];
  sql: SqlExecution[];
  executors: { added: ExecutorAddedEvent[]; removed: ExecutorRemovedEvent[] };
  runAggregates: RunAggregates | null;
  evidenceAvailability: EvidenceAvailability | null;
  catalog: Finding[];
  configFindings: Finding[];
  skippedLines: number;
  interpretation: RunInterpretation;
}

/** Converts an in-memory AppModel (Map-based, as collectRun()/the browser
 * worker produce it) plus its catalog/configFindings and their interpretation
 * (`interpretRun`, which indexes them in this same catalog-then-config order) into a plain, JSON-serializable object for the HTML export's data.js.
 * Maps become arrays; main-export.tsx rebuilds them client-side keyed the
 * same way the store already expects (Stage.id, Job.id,
 * SqlExecution.id). Maps and Sets nested deeper keep their type through
 * `reviveExportCollections`. Deliberately excludes raw per-task TaskData, which is far
 * too large to inline; task-detail widgets degrade gracefully in export mode. */
export function buildExportRunData(
  appModel: AppModel,
  catalog: Finding[],
  configFindings: Finding[],
  skippedLines: number,
  interpretation: RunInterpretation,
  provenance: ExportProvenance,
): ExportRunData {
  return encodeCollections({
    schemaVersion: EXPORT_DATA_SCHEMA_VERSION,
    provenance,
    app: appModel.app,
    stages: [...appModel.stages.values()],
    jobs: [...appModel.jobs.values()],
    sql: [...appModel.sql.values()],
    executors: appModel.executors,
    runAggregates: appModel.runAggregates,
    evidenceAvailability: appModel.evidenceAvailability,
    catalog,
    configFindings,
    skippedLines,
    interpretation,
  }) as ExportRunData;
}

// Maps and Sets nested inside the payload (`app.rddInfo`, each stage's
// `executorMetrics`) would serialize to `{}` under plain JSON, and a widget
// calling `.values()` on one then throws. They travel as tagged plain objects
// instead, which survive JSON and redaction's deep copy alike;
// `reviveExportCollections` turns them back on load.
const MAP_TAG = '__sparkforensicsMap';
const SET_TAG = '__sparkforensicsSet';

export function encodeCollections(value: unknown): unknown {
  if (value instanceof Map) return { [MAP_TAG]: [...value].map(([k, v]) => [encodeCollections(k), encodeCollections(v)]) };
  if (value instanceof Set) return { [SET_TAG]: [...value].map(encodeCollections) };
  if (Array.isArray(value)) return value.map(encodeCollections);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeCollections(v)]));
  }
  return value;
}

/** The in-memory counterpart of `reviveExportCollections`: rebuilds every
 * tagged Map and Set in a tree `encodeCollections` produced, without a JSON
 * round trip. */
export function decodeCollections(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeCollections);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record[MAP_TAG])) {
      return new Map((record[MAP_TAG] as [unknown, unknown][]).map(([k, v]) => [decodeCollections(k), decodeCollections(v)]));
    }
    if (Array.isArray(record[SET_TAG])) return new Set((record[SET_TAG] as unknown[]).map(decodeCollections));
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decodeCollections(v)]));
  }
  return value;
}

/** `JSON.parse` reviver for the export payload: rebuilds every Map and Set
 * `buildExportRunData` tagged. */
export function reviveExportCollections(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record[MAP_TAG])) return new Map(record[MAP_TAG] as [unknown, unknown][]);
    if (Array.isArray(record[SET_TAG])) return new Set(record[SET_TAG] as unknown[]);
  }
  return value;
}
