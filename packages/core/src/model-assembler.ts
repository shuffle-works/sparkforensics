import type {
  AppModel,
  SparkAppInfo,
  Stage,
  SqlExecution,
  PlanNode,
  ExecutorEvent,
  Job,
  RunAggregates,
} from './types.ts';

// Worker-message -> appModel assembly. Shared by the file-load and SHS-URL-load paths. Pure model
// mutation: analysis/render/persist stay in the caller via the onDone/onProgress/onError hooks.
export function createModelCallbacks(
  appModel: AppModel,
  { onProgress, onDone, onError }: {
    onProgress?: (data: unknown) => void;
    onDone?: (data: unknown) => void;
    onError?: (data: unknown) => void;
  },
) {
  return {
    onProgress,
    onApp(data: unknown) { appModel.app = data as SparkAppInfo; },
    onStage(data: unknown) {
      const stage = data as Stage;
      appModel.stages.set(stage.id, stage);
    },
    onSql(data: unknown) {
      // Full overwrite, not a merge: safe only because planTree (set by onSqlPlan from a separate
      // 'sqlPlan' message) is never present on a 'sql' message's data. That relies on
      // SQLAdaptiveExecutionUpdate always preceding SQLExecutionEnd (Spark re-plans mid-run, never
      // after the query finishes). A 'sql' producer that could arrive after onSqlPlan would need to merge.
      const event = data as { id: number; stageIds?: number[] };
      appModel.sql.set(event.id, data as SqlExecution);
      for (const stageId of (event.stageIds ?? [])) {
        const stage = appModel.stages.get(stageId);
        if (stage) stage.sqlExecutionId = event.id;
      }
    },
    onSqlPlan(data: unknown) {
      const event = data as { executionId: number; planTree: PlanNode };
      const exec = appModel.sql.get(event.executionId);
      if (exec) exec.planTree = event.planTree;
    },
    onExecutor(data: unknown) {
      const event = data as ExecutorEvent;
      if (event.kind === 'added') appModel.executors.added.push(event);
      else appModel.executors.removed.push(event);
    },
    onJob(data: unknown) {
      const job = data as Job;
      appModel.jobs.set(job.id, job);
    },
    onRunAggregates(data: unknown) { appModel.runAggregates = data as RunAggregates; },
    // Patch per-stage executorMetrics posted once before `done`: those events arrive after
    // StageCompleted, so the stage message itself carried an empty map. `data` is Map<stageId, Map<execId, metrics>>.
    onStageExecutorMetrics(data: unknown) {
      if (!(data instanceof Map)) return;
      const metricsByStage = data as Map<number, Map<string, unknown>>;
      for (const [stageId, execMetrics] of metricsByStage) {
        const stage = appModel.stages.get(stageId);
        if (stage) stage.executorMetrics = execMetrics;
      }
    },
    // Patch speculation totals that grew after StageCompleted: Spark kills a losing speculative
    // copy only once its stage finishes. `data` is Map<stageId, { speculationWasteMs, speculationWastedAttempts }>.
    onStageSpeculationWaste(data: unknown) {
      const totalsByStage = data as Map<number, { speculationWasteMs: number; speculationWastedAttempts: number }>;
      for (const [stageId, totals] of totalsByStage) {
        const stage = appModel.stages.get(stageId);
        if (stage) {
          stage.speculationWasteMs = totals.speculationWasteMs;
          stage.speculationWastedAttempts = totals.speculationWastedAttempts;
        }
      }
    },
    onDone, onError,
  };
}
