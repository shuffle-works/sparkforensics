import type {
  AppModel, Finding, SparkAppInfo, Stage, Job, SqlExecution,
  ExecutorAddedEvent, ExecutorRemovedEvent, RunAggregates, EvidenceAvailability,
} from './types.ts';

export const EXPORT_DATA_SCHEMA_VERSION = 1;

export interface ExportRunData {
  schemaVersion: number;
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
}

/** Converts an in-memory AppModel (Map-based, as collectRun()/the browser
 * worker produce it) plus the CLI's already-computed catalog/configFindings
 * into a plain, JSON-serializable object for the HTML export's data.js.
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
): ExportRunData {
  return encodeCollections({
    schemaVersion: EXPORT_DATA_SCHEMA_VERSION,
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
  }) as ExportRunData;
}

// Maps and Sets nested inside the payload (`app.rddInfo`, each stage's
// `executorMetrics`) would serialize to `{}` under plain JSON, and a widget
// calling `.values()` on one then throws. They travel as tagged plain objects
// instead, which survive JSON and redaction's deep copy alike;
// `reviveExportCollections` turns them back on load.
const MAP_TAG = '__sparkforensicsMap';
const SET_TAG = '__sparkforensicsSet';

function encodeCollections(value: unknown): unknown {
  if (value instanceof Map) return { [MAP_TAG]: [...value].map(([k, v]) => [encodeCollections(k), encodeCollections(v)]) };
  if (value instanceof Set) return { [SET_TAG]: [...value].map(encodeCollections) };
  if (Array.isArray(value)) return value.map(encodeCollections);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeCollections(v)]));
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
