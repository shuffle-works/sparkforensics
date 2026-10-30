// A run as plain data and back: the one pair behind session snapshots and the HTML export.
// `SerializedRun` lists every field of an `AnalyzedRun` and of its model, and `FIELDS` states how
// each one is read from the run and how redaction treats it. Both are typed over the run, so a field
// added to the model or the run does not compile until it is serialized and given a policy.
import { isSupportedEvidenceAvailability } from './evidence-availability.ts';
import type { AnalyzedRun, TaskDataSource } from './analyzed-run.ts';
import type { RunInterpretation } from './run-interpretation.ts';
import type {
  AppModel, EvidenceAvailability, Finding, Job, RunAggregates, SparkAppInfo, SqlExecution, Stage, StageId, TaskData,
} from './types.ts';

/** The fields of an `AppModel`, with its collections as arrays. */
export interface SerializedModel {
  app: SparkAppInfo | null;
  stages: Stage[];
  jobs: Job[];
  sql: SqlExecution[];
  executors: AppModel['executors'];
  runAggregates: RunAggregates | null;
  evidenceAvailability: EvidenceAvailability | null;
  skippedLines: number;
  unreadableSqlExecutions: number[] | null;
}

/** `AnalyzedRun` with its collections as arrays, so it survives JSON once nested Maps are tagged
 * (`encodeCollections`). */
export interface SerializedRun extends SerializedModel {
  catalog: Finding[];
  configFindings: Finding[];
  interpretation: RunInterpretation;
  /** The prefetched stages' task data; null when the run has none to carry. */
  taskData: Array<[StageId, TaskData]> | null;
}

/** What redaction does with a field: `redact` pseudonymizes it, `keep` copies it (counts and ids),
 * `derive` recomputes it from the redacted fields, and `drop` leaves it out. */
export type RedactionPolicy = 'redact' | 'keep' | 'derive' | 'drop';

/** Per serialized field: its redaction policy, and the model or run field it carries. */
export const FIELDS = {
  app: { redaction: 'redact', from: 'appModel.app' },
  stages: { redaction: 'redact', from: 'appModel.stages' },
  jobs: { redaction: 'redact', from: 'appModel.jobs' },
  sql: { redaction: 'redact', from: 'appModel.sql' },
  executors: { redaction: 'redact', from: 'appModel.executors' },
  runAggregates: { redaction: 'redact', from: 'appModel.runAggregates' },
  evidenceAvailability: { redaction: 'redact', from: 'appModel.evidenceAvailability' },
  skippedLines: { redaction: 'keep', from: 'appModel.skippedLines' },
  unreadableSqlExecutions: { redaction: 'keep', from: 'appModel.unreadableSqlExecutions' },
  catalog: { redaction: 'redact', from: 'catalog' },
  configFindings: { redaction: 'redact', from: 'configFindings' },
  interpretation: { redaction: 'derive', from: 'interpretation' },
  taskData: { redaction: 'drop', from: 'taskData' },
} as const satisfies Record<keyof SerializedRun, { redaction: RedactionPolicy; from: string }>;

/** Every model field and every run field other than the model, as a path in `FIELDS`. A path
 * missing from `FIELDS` fails to compile, which is how a new run or model field is forced into it. */
type RunFieldPath = `appModel.${keyof AppModel}` | Exclude<keyof AnalyzedRun, 'appModel'>;
type SerializedPaths = (typeof FIELDS)[keyof SerializedRun]['from'];
const everyFieldIsSerialized: [RunFieldPath] extends [SerializedPaths] ? true : never = true;
void everyFieldIsSerialized;

function serializedTaskData(source: TaskDataSource, cached: ReadonlyMap<StageId, TaskData> | undefined): SerializedRun['taskData'] {
  if (source.kind === 'snapshot') return [...source.stages];
  return source.kind === 'worker' && cached && cached.size > 0 ? [...cached] : null;
}

export function serializeModel(appModel: AppModel): SerializedModel {
  return {
    app: appModel.app,
    stages: [...appModel.stages.values()],
    jobs: [...appModel.jobs.values()],
    sql: [...appModel.sql.values()],
    executors: appModel.executors,
    runAggregates: appModel.runAggregates,
    evidenceAvailability: appModel.evidenceAvailability,
    skippedLines: appModel.skippedLines ?? 0,
    unreadableSqlExecutions: appModel.unreadableSqlExecutions ?? null,
  };
}

export function deserializeModel(data: SerializedModel): AppModel {
  return {
    app: data.app,
    stages: new Map(data.stages.map((stage) => [stage.id, stage])),
    executors: data.executors,
    // Keyed by SqlExecution.id, as the parse assembles it (model-assembler.ts).
    sql: new Map(data.sql.map((execution) => [execution.id, execution])),
    jobs: new Map(data.jobs.map((job) => [job.id, job])),
    runAggregates: data.runAggregates,
    // Fail-closed on unknown schema versions: a future incompatible ledger is never trusted as V1 data.
    evidenceAvailability: isSupportedEvidenceAvailability(data.evidenceAvailability) ? data.evidenceAvailability : null,
    skippedLines: data.skippedLines,
    ...(data.unreadableSqlExecutions ? { unreadableSqlExecutions: data.unreadableSqlExecutions } : {}),
  };
}

/** `cachedTaskData` is the task data fetched so far for a run that reads it from a worker: the run
 * itself holds no data, only the means to ask for it. */
export function serializeRun(run: AnalyzedRun, cachedTaskData?: ReadonlyMap<StageId, TaskData>): SerializedRun {
  return {
    ...serializeModel(run.appModel),
    catalog: run.catalog,
    configFindings: run.configFindings,
    interpretation: run.interpretation,
    taskData: serializedTaskData(run.taskData, cachedTaskData),
  };
}

export function deserializeRun(data: SerializedRun): AnalyzedRun {
  return {
    appModel: deserializeModel(data),
    catalog: data.catalog,
    configFindings: data.configFindings,
    interpretation: data.interpretation,
    taskData: data.taskData ? { kind: 'snapshot', stages: new Map(data.taskData) } : { kind: 'none' },
  };
}
