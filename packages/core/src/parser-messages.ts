// The messages the parser sends to its consumer: the browser worker posts them to the page, and the
// Node CLI and MCP path hands them straight to the same router (ingest.ts). One union, so a new
// message type or payload field fails to compile at every producer and consumer that misses it.
import type { StageExecutorMetricsSnapshot, FinalizedStage } from './stage-quantiles.ts';
import type {
  ExecutorEvent, Job, PlanNode, RunAggregates, SparkAppInfo, SqlExecution, StageAttemptTotals,
} from './types.ts';

/** What the parse could not read, sent once when it ends. */
export interface ParseSummary {
  skippedLines: number;
  /** SQL executions whose start event was skipped, so they are not in the model. Absent when none. */
  unreadableSqlExecutions?: number[];
}

export type ParserMessage =
  | { type: 'progress'; pct: number | null; linesProcessed: number }
  | { type: 'app'; data: SparkAppInfo }
  | { type: 'stage'; data: FinalizedStage }
  | { type: 'sql'; data: SqlExecution }
  | { type: 'sqlPlan'; data: { executionId: number; planTree: PlanNode } }
  | { type: 'executor'; data: ExecutorEvent }
  | { type: 'job'; data: Job }
  | { type: 'runAggregates'; data: RunAggregates }
  // The three below are re-posts, once before `done`, of what arrives after a stage completes.
  | { type: 'stageExecutorMetrics'; data: Map<number, Map<string, StageExecutorMetricsSnapshot>> }
  | { type: 'stageSpeculationWaste'; data: Map<number, { speculationWasteMs: number; speculationWastedAttempts: number }> }
  | { type: 'stageLateAttemptWork'; data: Map<number, StageAttemptTotals> }
  | { type: 'done'; data: ParseSummary }
  | { type: 'error'; message?: string; source?: 'shs'; code?: string }
  // The reply to a `getTaskData` request: one stage's packed per-task metrics.
  | { type: 'taskData'; stageId: number; reqId: string | number; metrics: Float64Array; fieldNames: string[] };

export type ParserMessageType = ParserMessage['type'];
export type ParserMessageOf<T extends ParserMessageType> = Extract<ParserMessage, { type: T }>;
export type ParserEmit = (msg: ParserMessage) => void;
