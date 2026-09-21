// Lightweight in-memory snapshot of a parsed file's view state, so switching
// between already-parsed files is instant without keeping multiple workers
// alive. Holds only the summary AppModel + catalog + prefetched task data,
// never the worker's full taskStore.

import { isSupportedEvidenceAvailability } from './evidence-availability.ts';
import type {
  AppModel,
  Finding,
  SparkAppInfo,
  Stage,
  ExecutorEvent,
  SqlExecution,
  Job,
  RunAggregates,
  EvidenceAvailability,
} from './types.ts';

export interface SessionSnapshot {
  app: SparkAppInfo | null;
  stages: Map<number, Stage>;
  executors: { added: ExecutorEvent[]; removed: ExecutorEvent[] };
  sql: Map<number, SqlExecution>;
  jobs: Map<number, Job>;
  runAggregates: RunAggregates | null;
  evidenceAvailability: EvidenceAvailability | null;
  catalog: Finding[];
  taskData: Map<number, unknown>;
}

export function captureSnapshot(
  appModel: AppModel,
  catalog: Finding[],
  taskDataCache: Map<number, unknown>,
): SessionSnapshot {
  return {
    app: appModel.app,
    stages: new Map(appModel.stages),
    executors: {
      added: [...appModel.executors.added],
      removed: [...appModel.executors.removed],
    },
    sql: new Map(appModel.sql),
    jobs: new Map(appModel.jobs),
    runAggregates: appModel.runAggregates,
    evidenceAvailability: appModel.evidenceAvailability,
    catalog: [...catalog],
    taskData: new Map(taskDataCache),
  };
}

// Restores a snapshot by mutating the live `appModel` and `taskDataCache` in
// place, so references captured elsewhere (e.g. the stage-detail modal closure)
// keep pointing at the current data. Returns the restored catalog.
export function applySnapshot(
  appModel: AppModel,
  taskDataCache: Map<number, unknown>,
  snapshot: SessionSnapshot,
): Finding[] {
  appModel.app = snapshot.app;
  appModel.stages = new Map(snapshot.stages);
  appModel.executors = {
    added: [...snapshot.executors.added] as AppModel['executors']['added'],
    removed: [...snapshot.executors.removed] as AppModel['executors']['removed'],
  };
  appModel.sql = new Map(snapshot.sql);
  appModel.jobs = new Map(snapshot.jobs);
  appModel.runAggregates = snapshot.runAggregates ?? null;
  // Fail-closed on unknown schema versions: a future incompatible ledger is
  // never trusted as V1 data.
  appModel.evidenceAvailability = isSupportedEvidenceAvailability(snapshot.evidenceAvailability)
    ? snapshot.evidenceAvailability
    : null;

  taskDataCache.clear();
  for (const [k, v] of snapshot.taskData) taskDataCache.set(k, v);

  return [...snapshot.catalog];
}
