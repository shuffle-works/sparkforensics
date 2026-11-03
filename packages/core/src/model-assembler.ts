import type { IngestHandlers } from './ingest.ts';
import type { ParseSummary } from './parser-messages.ts';
import type { AppModel } from './types.ts';

// The done message's counts of what the parse could not read. On the model, not only passed to onDone,
// so every consumer of the model (dashboard export, CLI, MCP) reports them the same way.
function recordParseGaps(appModel: AppModel, summary: ParseSummary): void {
  appModel.skippedLines = summary.skippedLines;
  if (summary.unreadableSqlExecutions) appModel.unreadableSqlExecutions = summary.unreadableSqlExecutions;
  else delete appModel.unreadableSqlExecutions;
}

// Worker-message -> appModel assembly. Shared by the file-load and SHS-URL-load paths. Pure model
// mutation: analysis/render/persist stay in the caller via the onDone/onProgress/onError hooks.
export function createModelCallbacks(
  appModel: AppModel,
  { onProgress, onDone, onError }: Pick<IngestHandlers, 'onProgress' | 'onDone' | 'onError'>,
): Required<IngestHandlers> {
  return {
    onProgress: onProgress ?? (() => {}),
    onApp(app) { appModel.app = app; },
    onStage(stage) { appModel.stages.set(stage.id, stage); },
    onSql(exec) {
      // Full overwrite, not a merge: safe only because planTree (set by onSqlPlan from a separate
      // 'sqlPlan' message) is never present on a 'sql' message's data. That relies on
      // SQLAdaptiveExecutionUpdate always preceding SQLExecutionEnd (Spark re-plans mid-run, never
      // after the query finishes). A 'sql' producer that could arrive after onSqlPlan would need to merge.
      appModel.sql.set(exec.id, exec);
      for (const stageId of (exec.stageIds ?? [])) {
        const stage = appModel.stages.get(stageId);
        if (stage) stage.sqlExecutionId = exec.id;
      }
    },
    onSqlPlan({ executionId, planTree }) {
      const exec = appModel.sql.get(executionId);
      if (exec) exec.planTree = planTree;
    },
    onExecutor(event) {
      if (event.kind === 'added') appModel.executors.added.push(event);
      else appModel.executors.removed.push(event);
    },
    onJob(job) { appModel.jobs.set(job.id, job); },
    onRunAggregates(aggregates) { appModel.runAggregates = aggregates; },
    // Patch per-stage executorMetrics posted once before `done`: those events arrive after
    // StageCompleted, so the stage message itself carried an empty map.
    onStageExecutorMetrics(metricsByStage) {
      for (const [stageId, execMetrics] of metricsByStage) {
        const stage = appModel.stages.get(stageId);
        if (stage) stage.executorMetrics = execMetrics;
      }
    },
    // Patch speculation totals that grew after StageCompleted: Spark kills a losing speculative
    // copy only once its stage finishes.
    onStageSpeculationWaste(totalsByStage) {
      for (const [stageId, totals] of totalsByStage) {
        const stage = appModel.stages.get(stageId);
        if (stage) {
          stage.speculationWasteMs = totals.speculationWasteMs;
          stage.speculationWastedAttempts = totals.speculationWastedAttempts;
        }
      }
    },
    // Patch the late work of failed attempts, whose TaskEnds arrive after StageCompleted.
    onStageLateAttemptWork(workByStage) {
      for (const [stageId, work] of workByStage) {
        const stage = appModel.stages.get(stageId);
        if (stage) stage.lateAttemptWork = work;
      }
    },
    onDone(summary) {
      recordParseGaps(appModel, summary);
      onDone?.(summary);
    },
    onError: onError ?? (() => {}),
  };
}
