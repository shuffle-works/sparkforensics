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
 * SqlExecution.id). Deliberately excludes raw per-task TaskData, which is far
 * too large to inline; task-detail widgets degrade gracefully in export mode. */
export function buildExportRunData(
  appModel: AppModel,
  catalog: Finding[],
  configFindings: Finding[],
  skippedLines: number,
): ExportRunData {
  return {
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
  };
}
