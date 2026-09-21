import { describe, it, expect } from 'vitest';
import {
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
  SqlExecutionEndEventSchema,
  DriverAccumUpdatesEventSchema,
  ExecutorAddedEventSchema,
  ExecutorRemovedEventSchema,
  SparkEventSchema,
  parseSparkPlanInfoTree,
} from '../src/event-schemas.ts';

describe('LogStartEventSchema', () => {
  it('accepts a valid LogStart', () => {
    const result = LogStartEventSchema.safeParse({
      Event: 'SparkListenerLogStart',
      'Spark Version': '3.5.0',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid LogStart', () => {
    const result = LogStartEventSchema.safeParse({
      Event: 'SparkListenerApplicationStart',
      'Spark Version': '3.5.0',
    });
    expect(result.success).toBe(false);
  });
});

describe('ApplicationStartEventSchema', () => {
  it('accepts a valid ApplicationStart', () => {
    const result = ApplicationStartEventSchema.safeParse({
      Event: 'SparkListenerApplicationStart',
      'App ID': 'app-1',
      'App Name': 'MyApp',
      Timestamp: 1000,
      'Spark Version': '3.5.0',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid ApplicationStart', () => {
    const result = ApplicationStartEventSchema.safeParse({
      Event: 'SparkListenerApplicationStart',
      Timestamp: 'not-a-number',
    });
    expect(result.success).toBe(false);
  });
});

describe('EnvironmentUpdateEventSchema', () => {
  it('accepts a valid EnvironmentUpdate', () => {
    const result = EnvironmentUpdateEventSchema.safeParse({
      Event: 'SparkListenerEnvironmentUpdate',
      'Spark Properties': { 'spark.executor.memory': '4g' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid EnvironmentUpdate', () => {
    const result = EnvironmentUpdateEventSchema.safeParse({
      Event: 'SparkListenerEnvironmentUpdate',
      'Spark Properties': 42,
    });
    expect(result.success).toBe(false);
  });
});

describe('ApplicationEndEventSchema', () => {
  it('accepts a valid ApplicationEnd', () => {
    const result = ApplicationEndEventSchema.safeParse({
      Event: 'SparkListenerApplicationEnd',
      Timestamp: 9999,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid ApplicationEnd', () => {
    const result = ApplicationEndEventSchema.safeParse({
      Event: 'SparkListenerJobEnd',
      Timestamp: 9999,
    });
    expect(result.success).toBe(false);
  });
});

describe('JobStartEventSchema', () => {
  it('accepts a valid JobStart', () => {
    const result = JobStartEventSchema.safeParse({
      Event: 'SparkListenerJobStart',
      'Job ID': 5,
      'Stage IDs': [18, 19],
      Properties: { 'spark.sql.execution.id': '10' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid JobStart', () => {
    const result = JobStartEventSchema.safeParse({
      Event: 'SparkListenerJobStart',
      'Stage IDs': ['not', 'numbers'],
    });
    expect(result.success).toBe(false);
  });
});

describe('JobEndEventSchema', () => {
  it('accepts a valid JobEnd', () => {
    const result = JobEndEventSchema.safeParse({
      Event: 'SparkListenerJobEnd',
      'Job ID': 0,
      'Completion Time': 500,
      'Job Result': { Result: 'JobSucceeded' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid JobEnd', () => {
    const result = JobEndEventSchema.safeParse({
      Event: 'SparkListenerJobEnd',
      'Completion Time': 500,
    });
    expect(result.success).toBe(false);
  });
});

describe('StageSubmittedEventSchema', () => {
  it('accepts a valid StageSubmitted', () => {
    const result = StageSubmittedEventSchema.safeParse({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': {
        'Stage ID': 18,
        'Stage Name': 'save',
        Details: '',
        'Submission Time': 1100,
        'RDD Info': [
          {
            'RDD ID': 1,
            Name: 'MapPartitionsRDD',
            Callsite: 'save at Foo.scala:1',
            'Storage Level': { 'Use Disk': false, 'Use Memory': true, Deserialized: true, Replication: 1 },
            'Number of Partitions': 10,
            'Number of Cached Partitions': 0,
            'Memory Size': 0,
            'Disk Size': 0,
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid StageSubmitted', () => {
    const result = StageSubmittedEventSchema.safeParse({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage Name': 'save' },
    });
    expect(result.success).toBe(false);
  });
});

describe('StageCompletedEventSchema', () => {
  it('accepts a valid StageCompleted', () => {
    const result = StageCompletedEventSchema.safeParse({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 2, 'Completion Time': 200 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid StageCompleted', () => {
    const result = StageCompletedEventSchema.safeParse({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Completion Time': 200 },
    });
    expect(result.success).toBe(false);
  });
});

describe('StageExecutorMetricsEventSchema', () => {
  it('accepts a valid StageExecutorMetrics', () => {
    const result = StageExecutorMetricsEventSchema.safeParse({
      Event: 'SparkListenerStageExecutorMetrics',
      'Stage ID': 1,
      'Executor ID': 'e1',
      'Executor Metrics': { JVMHeapMemory: 1024 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid StageExecutorMetrics', () => {
    const result = StageExecutorMetricsEventSchema.safeParse({
      Event: 'SparkListenerStageExecutorMetrics',
      'Stage ID': 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('TaskEndEventSchema', () => {
  it('accepts a valid TaskEnd', () => {
    const result = TaskEndEventSchema.safeParse({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Stage Attempt ID': 0,
      'Task End Reason': { Reason: 'Success' },
      'Task Info': {
        Index: 0,
        'Launch Time': 0,
        'Finish Time': 1,
        Failed: false,
        Killed: false,
        Speculative: false,
        Host: 'host-1',
        'Executor ID': 'e1',
        Locality: 'PROCESS_LOCAL',
      },
      'Task Metrics': {
        'Peak Execution Memory': 100,
        'JVM GC Time': 5,
        'Memory Bytes Spilled': 0,
        'Disk Bytes Spilled': 0,
        'Executor Run Time': 50,
        'Executor CPU Time': 40,
        'Shuffle Read Metrics': { 'Remote Bytes Read': 0, 'Local Bytes Read': 0, 'Fetch Wait Time': 0 },
        'Shuffle Write Metrics': { 'Shuffle Bytes Written': 0 },
        'Input Metrics': { 'Bytes Read': 0 },
        'Output Metrics': { 'Bytes Written': 0 },
      },
    });
    expect(result.success).toBe(true);
  });

  // Regression: Failed/Killed/Speculative are read tolerant of an absent key, so a log
  // variant omitting 'Speculative' must still parse, not be rejected as a skipped line.
  it('accepts a TaskEnd whose Task Info omits Speculative entirely', () => {
    const result = TaskEndEventSchema.safeParse({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Stage Attempt ID': 0,
      'Task End Reason': { Reason: 'Success' },
      'Task Info': {
        Index: 0,
        'Launch Time': 0,
        'Finish Time': 1,
        Failed: false,
        Killed: false,
        // 'Speculative' intentionally omitted.
        Host: 'host-1',
        'Executor ID': 'e1',
        Locality: 'PROCESS_LOCAL',
      },
      'Task Metrics': {
        'Peak Execution Memory': 100,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid TaskEnd', () => {
    const result = TaskEndEventSchema.safeParse({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': {
        Failed: 'yes',
        Killed: false,
        Speculative: false,
      },
    });
    expect(result.success).toBe(false);
  });

  // Regression: guards against a crafted TaskEnd with an unbounded Accumulables array
  // growing the never-pruned taskAccumStages.
  it('accepts a TaskEnd at the Accumulables size limit', () => {
    const result = TaskEndEventSchema.safeParse({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': {
        Index: 0,
        Accumulables: Array.from({ length: 10_000 }, (_, i) => ({ ID: i })),
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a TaskEnd carrying Task ID and Attempt Number', () => {
    const result = TaskEndEventSchema.safeParse({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': {
        Index: 0, 'Task ID': 42, 'Attempt Number': 1,
        'Launch Time': 0, 'Finish Time': 1,
      },
    });
    expect(result.success).toBe(true);
    expect(result.data['Task Info']['Task ID']).toBe(42);
    expect(result.data['Task Info']['Attempt Number']).toBe(1);
  });

  it('still parses a TaskEnd omitting Task ID and Attempt Number', () => {
    const result = TaskEndEventSchema.safeParse({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { Index: 0, 'Launch Time': 0, 'Finish Time': 1 },
    });
    expect(result.success).toBe(true);
    expect(result.data['Task Info']['Task ID']).toBeUndefined();
    expect(result.data['Task Info']['Attempt Number']).toBeUndefined();
  });

  it('rejects a TaskEnd whose Accumulables array exceeds the size limit', () => {
    const result = TaskEndEventSchema.safeParse({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': {
        Index: 0,
        Accumulables: Array.from({ length: 10_001 }, (_, i) => ({ ID: i })),
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('SqlExecutionStartEventSchema', () => {
  it('accepts a valid SQLExecutionStart', () => {
    const result = SqlExecutionStartEventSchema.safeParse({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 9,
      description: 'q1',
      time: 1000,
      physicalPlanDescription: '',
      sparkPlanInfo: { nodeName: 'Scan', simpleString: 'Scan', children: [], metrics: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid SQLExecutionStart', () => {
    const result = SqlExecutionStartEventSchema.safeParse({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 9,
      time: 1000,
      sparkPlanInfo: { simpleString: 'Scan', children: [] }, // missing nodeName
    });
    expect(result.success).toBe(false);
  });
});

describe('SqlExecutionEndEventSchema', () => {
  it('accepts a valid SQLExecutionEnd', () => {
    const result = SqlExecutionEndEventSchema.safeParse({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd',
      executionId: 9,
      time: 2000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid SQLExecutionEnd', () => {
    const result = SqlExecutionEndEventSchema.safeParse({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd',
      executionId: 9,
    });
    expect(result.success).toBe(false);
  });
});

describe('DriverAccumUpdatesEventSchema', () => {
  it('accepts a valid DriverAccumUpdates', () => {
    const result = DriverAccumUpdatesEventSchema.safeParse({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 5,
      accumUpdates: [[94, 10], [95, 20]],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid DriverAccumUpdates', () => {
    const result = DriverAccumUpdatesEventSchema.safeParse({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 5,
      accumUpdates: 'not-an-array',
    });
    expect(result.success).toBe(false);
  });
});

describe('ExecutorAddedEventSchema', () => {
  it('accepts a valid ExecutorAdded', () => {
    const result = ExecutorAddedEventSchema.safeParse({
      Event: 'SparkListenerExecutorAdded',
      Timestamp: 1000,
      'Executor ID': 'e1',
      'Executor Info': { Host: 'host-1', 'Total Cores': 4 },
      'Resource Profile Id': 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid ExecutorAdded', () => {
    const result = ExecutorAddedEventSchema.safeParse({
      Event: 'SparkListenerExecutorAdded',
      Timestamp: 1000,
    });
    expect(result.success).toBe(false);
  });
});

describe('ExecutorRemovedEventSchema', () => {
  it('accepts a valid ExecutorRemoved', () => {
    const result = ExecutorRemovedEventSchema.safeParse({
      Event: 'SparkListenerExecutorRemoved',
      Timestamp: 2000,
      'Executor ID': 'e1',
      'Removed Reason': 'Container killed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid ExecutorRemoved', () => {
    const result = ExecutorRemovedEventSchema.safeParse({
      Event: 'SparkListenerExecutorRemoved',
      Timestamp: 2000,
    });
    expect(result.success).toBe(false);
  });
});

describe('SparkEventSchema', () => {
  it('has exactly 16 entries matching processEvent\'s switch', () => {
    expect(SparkEventSchema.options.length).toBe(16);
  });

  it('variant set matches exactly the Event types the current switch handles', () => {
    const schemaVariants = SparkEventSchema.options.map((option) => option.shape.Event.value).sort();
    const switchHandledVariants = [
      'SparkListenerLogStart',
      'SparkListenerApplicationStart',
      'SparkListenerEnvironmentUpdate',
      'SparkListenerApplicationEnd',
      'SparkListenerJobStart',
      'SparkListenerJobEnd',
      'SparkListenerStageSubmitted',
      'SparkListenerStageCompleted',
      'SparkListenerStageExecutorMetrics',
      'SparkListenerTaskEnd',
      'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate',
      'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd',
      'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      'SparkListenerExecutorAdded',
      'SparkListenerExecutorRemoved',
    ].sort();
    expect(schemaVariants).toEqual(switchHandledVariants);
  });
});

describe('parseSparkPlanInfoTree', () => {
  it('parses a 3-level-deep valid tree', () => {
    const raw = {
      nodeName: 'root',
      simpleString: 'root detail',
      metrics: [{ name: 'rows', value: '100', metricType: 'sum' }],
      children: [
        {
          nodeName: 'mid',
          children: [
            { nodeName: 'leaf', simpleString: 'leaf detail', children: [] },
          ],
        },
      ],
    };
    const result = parseSparkPlanInfoTree(raw);
    expect(result.nodeName).toBe('root');
    expect(result.children).toHaveLength(1);
    expect(result.children[0].nodeName).toBe('mid');
    expect(result.children[0].children).toHaveLength(1);
    expect(result.children[0].children[0].nodeName).toBe('leaf');
    expect(result.children[0].children[0].simpleString).toBe('leaf detail');
  });

  it('throws on a node missing nodeName', () => {
    const raw = {
      nodeName: 'root',
      children: [{ simpleString: 'no name here', children: [] }],
    };
    expect(() => parseSparkPlanInfoTree(raw)).toThrow();
  });

  it('does not stack-overflow on a deliberately deep synthetic tree', () => {
    let node = { nodeName: 'leaf', children: [] };
    for (let i = 0; i < 1000; i++) {
      node = { nodeName: `n${i}`, children: [node] };
    }
    expect(() => parseSparkPlanInfoTree(node)).toThrow(/exceeds max depth/);
  });
});
