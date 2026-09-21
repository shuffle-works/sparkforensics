import { z } from 'zod';

// sparkPlanInfo: iterative (non-recursive-schema) tree parser.
//
// Validates the raw, unbounded-depth sparkPlanInfo tree on SQLExecutionStart/End events. Must
// NEVER be validated with z.lazy(): it uses an explicit heap-allocated stack so zod never sees the
// full tree depth in one call.

// resolvePlanTree reads m.accumulatorId to look up the accumulator's live value in accumMap.
// Optional (not required): resolvePlanTree tolerates a missing accumulatorId (accumMap.has
// resolves false, the metric contributes no value).
const SparkPlanMetricSchema = z.object({
  name: z.string(),
  accumulatorId: z.number().optional(),
  value: z.union([z.string(), z.number()]).optional(),
  metricType: z.string().optional(),
});

// Shallow shape only. `children` is z.array(z.unknown()): each child gets its own shallow parse
// in the iterative walk below, so this schema never recurses and zod never sees the full depth.
// `metadata` (file-scan Location/Format/ReadSchema/...) is kept though nothing reads it yet: real
// data crossing the worker boundary.
const SparkPlanInfoNodeSchema = z.object({
  nodeName: z.string(),
  simpleString: z.string().optional(),
  metrics: z.array(SparkPlanMetricSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  children: z.array(z.unknown()),
});

export interface SparkPlanInfo {
  nodeName: string;
  simpleString?: string;
  metrics?: { name: string; accumulatorId?: number; value?: string | number; metricType?: string }[];
  metadata?: Record<string, unknown>;
  children: SparkPlanInfo[];
}

const MAX_PLAN_DEPTH = 500;

interface Frame {
  shallow: z.infer<typeof SparkPlanInfoNodeSchema>;
  children: SparkPlanInfo[];
  pendingRaw: unknown[];
  depth: number;
}

export function parseSparkPlanInfoTree(raw: unknown): SparkPlanInfo {
  const rootShallow = SparkPlanInfoNodeSchema.parse(raw);
  const rootFrame: Frame = { shallow: rootShallow, children: [], pendingRaw: [...rootShallow.children], depth: 0 };
  const stack: Frame[] = [rootFrame];
  const parentOf = new Map<Frame, Frame>();

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.pendingRaw.length === 0) {
      stack.pop();
      const built: SparkPlanInfo = { ...top.shallow, children: top.children };
      const parent = parentOf.get(top);
      if (parent) {
        parent.children.push(built);
        continue;
      }
      return built;
    }
    if (top.depth > MAX_PLAN_DEPTH) {
      throw new Error(`sparkPlanInfo tree exceeds max depth of ${MAX_PLAN_DEPTH}`);
    }
    const nextRaw = top.pendingRaw.shift();
    const shallow = SparkPlanInfoNodeSchema.parse(nextRaw);
    const frame: Frame = { shallow, children: [], pendingRaw: [...shallow.children], depth: top.depth + 1 };
    parentOf.set(frame, top);
    stack.push(frame);
  }
  throw new Error('unreachable: sparkPlanInfo tree stack exhausted without resolving root');
}

// A zod field wrapping parseSparkPlanInfoTree for the SQLExecutionStart schema. Nullable/optional
// to mirror `event.sparkPlanInfo ?? null`. Deliberately NOT z.lazy(): defers to the iterative parser.
const SparkPlanInfoFieldSchema = z
  .unknown()
  .nullable()
  .optional()
  .transform((val, ctx) => {
    if (val == null) return null;
    try {
      return parseSparkPlanInfoTree(val);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : String(err) });
      return z.NEVER;
    }
  });

// Fully-specified event schemas.

// SparkListenerLogStart case (inline: sets state.pendingSparkVersion).
export const LogStartEventSchema = z.object({
  Event: z.literal('SparkListenerLogStart'),
  'Spark Version': z.string().optional(),
});

// startApplication.
export const ApplicationStartEventSchema = z.object({
  Event: z.literal('SparkListenerApplicationStart'),
  'App ID': z.string().optional(),
  'App Name': z.string().optional(),
  Timestamp: z.number().optional(),
  'Spark Version': z.string().optional(),
});

// updateEnvironment: 'Spark Properties' is fed to normalizeSparkProperties, which accepts
// object | array | null. Property VALUES are string|number|boolean (a real config can carry a
// bare JSON number/boolean); normalizeSparkProperties coerces each to a string at the boundary.
const SparkPropertyValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const EnvironmentUpdateEventSchema = z.object({
  Event: z.literal('SparkListenerEnvironmentUpdate'),
  'Spark Properties': z.union([
    z.record(z.string(), SparkPropertyValueSchema),
    z.array(z.tuple([z.string(), SparkPropertyValueSchema])),
    z.null(),
  ]).optional(),
});

// inline ApplicationEnd case.
export const ApplicationEndEventSchema = z.object({
  Event: z.literal('SparkListenerApplicationEnd'),
  Timestamp: z.number().optional(),
});

// addExecutor. `Resource Profile Id` is read from BOTH inside 'Executor Info' (real Spark
// placement) and top-level (a variant that hoists it), so both must be declared or the nested one
// is silently stripped. `Timestamp` is read with no defensive operator, so it's required.
export const ExecutorAddedEventSchema = z.object({
  Event: z.literal('SparkListenerExecutorAdded'),
  Timestamp: z.number(),
  'Executor ID': z.string(),
  'Executor Info': z.object({
    Host: z.string().optional(),
    'Total Cores': z.number().optional(),
    'Resource Profile Id': z.number().optional(),
  }).optional(),
  'Resource Profile Id': z.number().optional(),
});

// removeExecutor. `Timestamp` is read with no defensive operator, so it's required.
export const ExecutorRemovedEventSchema = z.object({
  Event: z.literal('SparkListenerExecutorRemoved'),
  Timestamp: z.number(),
  'Executor ID': z.string(),
  'Removed Reason': z.string().optional(),
});

// Schemas transcribed from their handlers.

// startJob. 'spark.sql.execution.id' is read then parseInt'd, which coerces to string internally,
// so it tolerates the raw value being a number; widened to string|number (some logs emit a JSON number).
export const JobStartEventSchema = z.object({
  Event: z.literal('SparkListenerJobStart'),
  'Job ID': z.number().optional(),
  'Submission Time': z.number().optional(),
  'Stage IDs': z.array(z.number()).optional(),
  Properties: z.object({
    'spark.sql.execution.id': z.union([z.string(), z.number()]).optional(),
  }).optional(),
});

// endJob.
export const JobEndEventSchema = z.object({
  Event: z.literal('SparkListenerJobEnd'),
  'Job ID': z.number(),
  'Completion Time': z.number().optional(),
  'Job Result': z.object({
    Result: z.string().optional(),
    Exception: z.object({
      Message: z.string().optional(),
    }).optional(),
  }).optional(),
});

// submitStage + mergeStageRddInfo (called from submitStage with the same 'Stage Info', so its
// 'RDD Info' reads are part of this event's shape too).
const RddInfoSchema = z.object({
  'RDD ID': z.number().optional(),
  Name: z.string().optional(),
  Callsite: z.string().optional(),
  'Storage Level': z.object({
    'Use Disk': z.boolean().optional(),
    'Use Memory': z.boolean().optional(),
    Deserialized: z.boolean().optional(),
    Replication: z.number().optional(),
  }).optional(),
  'Number of Partitions': z.number().optional(),
  // 'Number of Cached Partitions'/'Memory Size'/'Disk Size' are read via `rdd[field] || prev || 0`,
  // tolerant of the key being absent, so a variant that omits one must still parse.
  'Number of Cached Partitions': z.number().optional(),
  'Memory Size': z.number().optional(),
  'Disk Size': z.number().optional(),
});

export const StageSubmittedEventSchema = z.object({
  Event: z.literal('SparkListenerStageSubmitted'),
  'Stage Info': z.object({
    'Stage ID': z.number(),
    'Stage Name': z.string().optional(),
    Details: z.string().optional(),
    'Submission Time': z.number().optional(),
    'Parent IDs': z.array(z.number()).optional(),
    'RDD Info': z.array(RddInfoSchema).optional(),
  }),
});

// inline StageCompleted case.
export const StageCompletedEventSchema = z.object({
  Event: z.literal('SparkListenerStageCompleted'),
  'Stage Info': z.object({
    'Stage ID': z.number(),
    'Completion Time': z.number().optional(),
    'Failure Reason': z.string().optional(),
  }),
});

// recordStageExecutorMetrics.
export const StageExecutorMetricsEventSchema = z.object({
  Event: z.literal('SparkListenerStageExecutorMetrics'),
  'Stage ID': z.number(),
  'Executor ID': z.string(),
  'Executor Metrics': z.record(z.string(), z.number()).optional(),
});

const MAX_ACCUMULABLES_PER_TASK = 10_000;

// accumulateTask.
export const TaskEndEventSchema = z.object({
  Event: z.literal('SparkListenerTaskEnd'),
  'Stage ID': z.number(),
  'Stage Attempt ID': z.number().optional(),
  'Task End Reason': z.object({
    Reason: z.string().optional(),
  }).optional(),
  'Task Info': z.object({
    'Launch Time': z.number().optional(),
    'Finish Time': z.number().optional(),
    // Failed/Killed are read via `info['Failed'] || info['Killed']`, tolerant of either being
    // absent, so variants that omit them must still parse.
    Failed: z.boolean().optional(),
    Killed: z.boolean().optional(),
    // Speculative is read via `=== true`, also tolerant of the key being absent, so it's optional too.
    Speculative: z.boolean().optional(),
    Host: z.string().optional(),
    'Executor ID': z.string().optional(),
    Locality: z.string().optional(),
    Index: z.number().optional(),
    'Task ID': z.number().optional(),
    'Attempt Number': z.number().optional(),
    // Bounded well above any real per-task metric count: caps how much a crafted TaskEnd can grow
    // taskAccumStages, which is never pruned for the life of the parse.
    Accumulables: z.array(z.object({
      ID: z.number(),
      Update: z.union([z.string(), z.number()]).optional(),
      Value: z.union([z.string(), z.number()]).optional(),
    })).max(MAX_ACCUMULABLES_PER_TASK).optional(),
  }).optional(),
  'Task Metrics': z.object({
    'Peak Execution Memory': z.number().optional(),
    'JVM GC Time': z.number().optional(),
    'Memory Bytes Spilled': z.number().optional(),
    'Disk Bytes Spilled': z.number().optional(),
    'Executor Run Time': z.number().optional(),
    'Executor CPU Time': z.number().optional(),
    'Shuffle Read Metrics': z.object({
      'Remote Bytes Read': z.number().optional(),
      'Local Bytes Read': z.number().optional(),
      'Fetch Wait Time': z.number().optional(),
    }).optional(),
    'Shuffle Write Metrics': z.object({
      'Shuffle Bytes Written': z.number().optional(),
    }).optional(),
    'Input Metrics': z.object({
      'Bytes Read': z.number().optional(),
    }).optional(),
    'Output Metrics': z.object({
      'Bytes Written': z.number().optional(),
    }).optional(),
  }).optional(),
});

// startSqlExecution.
export const SqlExecutionStartEventSchema = z.object({
  Event: z.literal('org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart'),
  executionId: z.number(),
  description: z.string().optional(),
  time: z.number(),
  physicalPlanDescription: z.string().optional(),
  sparkPlanInfo: SparkPlanInfoFieldSchema,
});

// applyAdaptiveExecutionUpdate: AQE re-plans mid-query and re-emits sparkPlanInfo for the same
// executionId; last write wins.
export const SqlAdaptiveExecutionUpdateEventSchema = z.object({
  Event: z.literal('org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate'),
  executionId: z.number(),
  physicalPlanDescription: z.string().optional(),
  sparkPlanInfo: SparkPlanInfoFieldSchema,
});

// endSqlExecution.
export const SqlExecutionEndEventSchema = z.object({
  Event: z.literal('org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd'),
  executionId: z.number(),
  time: z.number(),
});

// applyDriverAccumUpdates.
export const DriverAccumUpdatesEventSchema = z.object({
  Event: z.literal('org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates'),
  executionId: z.number(),
  accumUpdates: z.array(z.tuple([z.number(), z.number()])),
});

// Discriminated union: one entry per `case` in processEvent's switch.
export const SparkEventSchema = z.discriminatedUnion('Event', [
  LogStartEventSchema,
  ApplicationStartEventSchema,
  EnvironmentUpdateEventSchema,
  ApplicationEndEventSchema,
  JobStartEventSchema,
  JobEndEventSchema,
  StageSubmittedEventSchema,
  StageCompletedEventSchema,
  StageExecutorMetricsEventSchema,
  TaskEndEventSchema,
  SqlExecutionStartEventSchema,
  SqlAdaptiveExecutionUpdateEventSchema,
  SqlExecutionEndEventSchema,
  DriverAccumUpdatesEventSchema,
  ExecutorAddedEventSchema,
  ExecutorRemovedEventSchema,
]);
export type SparkEvent = z.infer<typeof SparkEventSchema>;
