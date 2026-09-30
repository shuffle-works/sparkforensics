import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRun } from '../src/cli/collect-run.ts';
import { computeRunMetrics, METRICS_SCHEMA_VERSION } from '../src/run-metrics.ts';
import { stageIdentity } from '../src/run-comparison.ts';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

const GIB = 1024;

function taskEnd(stageId, id, { runMs = 100, cpuNs, records, spill = 0, peak, failed = false } = {}) {
  return JSON.stringify({
    Event: 'SparkListenerTaskEnd', 'Stage ID': stageId, 'Stage Attempt ID': 0,
    'Task Info': { 'Task ID': id, Index: id, 'Launch Time': 0, 'Finish Time': runMs, Failed: failed, Killed: false, Speculative: false },
    'Task Metrics': {
      'Executor Run Time': runMs, 'JVM GC Time': 5, 'Memory Bytes Spilled': spill, 'Disk Bytes Spilled': spill / 2,
      ...(cpuNs != null ? { 'Executor CPU Time': cpuNs } : {}),
      ...(peak != null ? { 'Peak Execution Memory': peak } : {}),
      'Input Metrics': { 'Bytes Read': 1000 },
      'Output Metrics': { 'Bytes Written': 500, ...(records != null ? { 'Records Written': records } : {}) },
      'Shuffle Read Metrics': { 'Remote Bytes Read': 10, 'Local Bytes Read': 5 },
      'Shuffle Write Metrics': { 'Shuffle Bytes Written': 7 },
    },
  });
}

function stageLines(stageId, name, tasks, details = '') {
  return [
    JSON.stringify({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': stageId, 'Stage Name': name, Details: details, 'Number of Tasks': tasks.length, 'Submission Time': 1000 } }),
    ...tasks,
    JSON.stringify({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': stageId, 'Stage Name': name, Details: details, 'Number of Tasks': tasks.length, 'Submission Time': 1000, 'Completion Time': 2000 } }),
  ];
}

async function model(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-metrics-'));
  const path = join(dir, 'eventlog');
  writeFileSync(path, `${lines.join('\n')}\n`);
  try { return (await collectRun(path)).appModel; } finally { rmSync(dir, { recursive: true, force: true }); }
}

const START = JSON.stringify({ Event: 'SparkListenerApplicationStart', 'App ID': 'application_0000000000000_0001', 'App Name': 't', Timestamp: 0 });
const END = JSON.stringify({ Event: 'SparkListenerApplicationEnd', Timestamp: 3600000 });
const env = (props) => JSON.stringify({ Event: 'SparkListenerEnvironmentUpdate', 'Spark Properties': props });
const added = (id, ts, cores = 4) => JSON.stringify({ Event: 'SparkListenerExecutorAdded', Timestamp: ts, 'Executor ID': id, 'Executor Info': { Host: `h${id}`, 'Total Cores': cores } });
const removed = (id, ts) => JSON.stringify({ Event: 'SparkListenerExecutorRemoved', Timestamp: ts, 'Executor ID': id, 'Removed Reason': 'done' });

describe('computeRunMetrics on a parsed log', () => {
  it('totals time, data and shape across stages and keys stage rows by fingerprint', async () => {
    const appModel = await model([
      env({ 'spark.executor.memory': '4g', 'spark.executor.memoryOverhead': '1g' }), START,
      added('1', 0), removed('1', 1800000),
      ...stageLines(1, 'map at A.scala:1', [taskEnd(1, 0, { runMs: 100, cpuNs: 50e6, records: 3, spill: 100, peak: 64 }), taskEnd(1, 1, { runMs: 300, cpuNs: 150e6, records: 4, spill: 100, peak: 128 })]),
      ...stageLines(2, 'save at B.scala:2', [taskEnd(2, 0, { runMs: 200, cpuNs: 100e6, records: 10 })]),
      END,
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.python).toEqual({ shareOfTaskRunTime: 0 });
    expect(m.schemaVersion).toBe(METRICS_SCHEMA_VERSION);
    expect(m.runComplete).toBe(true);
    expect(m.time).toEqual({ wallClockMs: 3600000, executorCpuTimeMs: 300, executorRunTimeMs: 600, gcTimeMs: 15 });
    expect(m.data).toEqual({
      memorySpillBytes: 200, diskSpillBytes: 100, shuffleReadBytes: 45, shuffleWriteBytes: 21,
      inputBytes: 3000, outputBytes: 1500, outputRows: 17, peakExecutionMemoryBytes: 128,
    });
    expect(m.shape).toMatchObject({ taskCount: 3, stageCount: 2, failedStageAttempts: 0, retriedStages: 0, failedTasks: 0, retriedTasks: 0 });
    const keys = Object.keys(m.stages);
    expect(keys).toEqual([...appModel.stages.values()].map((s) => stageIdentity(s, appModel)));
    const first = m.stages[keys[0]];
    expect(first).toMatchObject({ stageIds: [1], taskCount: 2, executorCpuTimeMs: 200, outputRows: 7, durationMs: 1000, failed: false, retried: false, python: false });
  });

  it('computes allocation from executor lifecycle, closing survivors at application end', async () => {
    const appModel = await model([
      env({ 'spark.executor.memory': '4g', 'spark.executor.memoryOverhead': '1g' }), START,
      added('1', 0, 4), removed('1', 1800000), added('2', 1800000, 2),
      ...stageLines(1, 'map', [taskEnd(1, 0)]), END,
    ]);
    const { allocation } = computeRunMetrics(appModel);
    // executor 1: 4 cores x 0.5h; executor 2: 2 cores x 0.5h (closed at the 1h application end)
    expect(allocation.coreHours).toBeCloseTo(3, 10);
    // 5 GiB (4g + 1g overhead) each, same hours
    expect(allocation.memoryGbHours).toBeCloseTo(5 * 0.5 + 5 * 0.5, 10);
  });

  it('counts stage attempts across a resubmit, apart from task retries', async () => {
    const completed = (id, reason) => JSON.stringify({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': id, 'Submission Time': 1000, 'Completion Time': 2000, ...(reason ? { 'Failure Reason': reason } : {}) },
    });
    const submitted = (id, attempt) => JSON.stringify({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': id, 'Stage Attempt ID': attempt, 'Stage Name': 'reduce', 'Submission Time': 1000 } });
    const appModel = await model([
      START,
      // Attempt 0 hits a fetch failure; attempt 1 succeeds, so the final record has no failure reason.
      submitted(1, 0), taskEnd(1, 0, { failed: true }), completed(1, 'FetchFailed'),
      submitted(1, 1), taskEnd(1, 1), completed(1),
      ...stageLines(2, 'map', [taskEnd(2, 0)]),
      END,
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.shape).toMatchObject({ stageCount: 2, failedStageAttempts: 1, retriedStages: 1 });
    const rows = Object.values(m.stages);
    expect(rows.map((r) => [r.stageIds, r.failed, r.retried])).toEqual([[[1], true, true], [[2], false, false]]);
  });

  it('sums the work of a failed attempt with its retry, leaving the stage record at the latest attempt', async () => {
    const submitted = (attempt) => JSON.stringify({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Stage Attempt ID': attempt, 'Stage Name': 'reduce', 'Submission Time': 1000 + attempt * 5000 } });
    const completed = (attempt, reason) => JSON.stringify({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 1000 + attempt * 5000, 'Completion Time': 2000 + attempt * 5000, ...(reason ? { 'Failure Reason': reason } : {}) },
    });
    const appModel = await model([
      START,
      submitted(0),
      taskEnd(1, 0, { runMs: 100, cpuNs: 50e6, failed: true }), taskEnd(1, 1, { runMs: 200, cpuNs: 100e6, records: 2 }),
      completed(0, 'FetchFailed'),
      submitted(1), taskEnd(1, 2, { runMs: 300, cpuNs: 150e6, records: 5 }), completed(1),
      END,
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.time).toMatchObject({ executorCpuTimeMs: 300, executorRunTimeMs: 600, gcTimeMs: 15 });
    expect(m.data).toMatchObject({ inputBytes: 3000, outputRows: 7 });
    expect(m.shape).toMatchObject({ taskCount: 3, failedTasks: 1 });
    expect(Object.values(m.stages)[0]).toMatchObject({ taskCount: 3, failedTasks: 1, executorRunTimeMs: 600, durationMs: 2000 });
    expect(appModel.stages.get(1)).toMatchObject({ taskCount: 1, failedTasks: 0, executorRunTime: 300 });
  });

  it('counts the late tasks of a failed final attempt that is never resubmitted', async () => {
    const appModel = await model([
      START,
      JSON.stringify({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Stage Attempt ID': 0, 'Stage Name': 'reduce', 'Submission Time': 1000 } }),
      taskEnd(1, 0, { runMs: 100, cpuNs: 50e6, failed: true }),
      JSON.stringify({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 1000, 'Completion Time': 2000, 'Failure Reason': 'aborted' } }),
      // The attempt's other running task is killed after the stage aborts.
      taskEnd(1, 1, { runMs: 400, cpuNs: 200e6, failed: true }),
      END,
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.time).toMatchObject({ executorCpuTimeMs: 250, executorRunTimeMs: 500 });
    expect(m.shape).toMatchObject({ taskCount: 2, failedTasks: 2, failedStageAttempts: 1, retriedStages: 0 });
    expect(Object.values(m.stages)[0]).toMatchObject({ taskCount: 2, durationMs: 1000 });
    expect(appModel.stages.get(1)).toMatchObject({ taskCount: 1, failedTasks: 1, executorRunTime: 100 });
  });

  it('counts a failed attempt\'s task that ends after its StageCompleted, leaving the stage record unchanged', async () => {
    const submitted = (attempt) => JSON.stringify({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Stage Attempt ID': attempt, 'Stage Name': 'reduce', 'Submission Time': 1000 + attempt * 5000 } });
    const completed = (attempt, reason) => JSON.stringify({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 1000 + attempt * 5000, 'Completion Time': 2000 + attempt * 5000, ...(reason ? { 'Failure Reason': reason } : {}) },
    });
    const appModel = await model([
      START,
      submitted(0), taskEnd(1, 0, { runMs: 100, cpuNs: 50e6, failed: true }), completed(0, 'FetchFailed'),
      // A zombie task of attempt 0 finishes after the failed StageCompleted, before the resubmit.
      taskEnd(1, 1, { runMs: 400, cpuNs: 200e6, records: 4 }),
      submitted(1), taskEnd(1, 2, { runMs: 300, cpuNs: 150e6, records: 5 }), completed(1),
      END,
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.time).toMatchObject({ executorCpuTimeMs: 400, executorRunTimeMs: 800 });
    expect(m.data).toMatchObject({ outputRows: 9 });
    expect(m.shape).toMatchObject({ taskCount: 3, failedTasks: 1 });
    expect(appModel.stages.get(1)).toMatchObject({ taskCount: 1, failedTasks: 0, executorRunTime: 300 });
  });

  it('counts an earlier failed attempt\'s task that ends after a successful retry', async () => {
    const submitted = (attempt) => JSON.stringify({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Stage Attempt ID': attempt, 'Stage Name': 'reduce', 'Submission Time': 1000 + attempt * 5000 } });
    const completed = (attempt, reason) => JSON.stringify({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 1000 + attempt * 5000, 'Completion Time': 2000 + attempt * 5000, ...(reason ? { 'Failure Reason': reason } : {}) },
    });
    const appModel = await model([
      START,
      submitted(0), taskEnd(1, 0, { runMs: 100, cpuNs: 50e6, failed: true }), completed(0, 'FetchFailed'),
      submitted(1), taskEnd(1, 2, { runMs: 300, cpuNs: 150e6, records: 5 }), completed(1),
      // A zombie task of attempt 0 finishes after attempt 1 has already succeeded.
      taskEnd(1, 1, { runMs: 400, cpuNs: 200e6, records: 4 }),
      END,
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.time).toMatchObject({ executorCpuTimeMs: 400, executorRunTimeMs: 800 });
    expect(m.data).toMatchObject({ outputRows: 9 });
    expect(m.shape).toMatchObject({ taskCount: 3, failedTasks: 1 });
    expect(appModel.stages.get(1)).toMatchObject({ taskCount: 1, failedTasks: 0, executorRunTime: 300 });
    expect(appModel.stages.get(1)).not.toHaveProperty('stageAttemptId');
  });

  it('keeps task-level failures and retries in failedTasks / retriedTasks', () => {
    const appModel = {
      app: makeApp(), sql: new Map(), jobs: new Map(), executors: { added: [], removed: [] },
      stages: new Map([
        [1, makeStage({ id: 1, name: 'a', stageAttempts: 1, failedStageAttempts: 0, failedTasks: 3, taskCount: 4 })],
        [2, makeStage({ id: 2, name: 'b', stageAttempts: 1, failedStageAttempts: 0, wastedAttempts: 2 })],
      ]),
    };
    const m = computeRunMetrics(appModel);
    expect(m.shape).toMatchObject({ failedStageAttempts: 0, retriedStages: 0, failedTasks: 3, retriedTasks: 2 });
  });

  it('reports null stage-attempt figures when a stage record carries no attempt count', () => {
    const appModel = {
      app: makeApp(), sql: new Map(), jobs: new Map(), executors: { added: [], removed: [] },
      stages: new Map([[1, makeStage({ id: 1, name: 'a' })]]),
    };
    const m = computeRunMetrics(appModel);
    expect(m.shape).toMatchObject({ failedStageAttempts: null, retriedStages: null });
    expect(Object.values(m.stages)[0]).toMatchObject({ failed: null, retried: null });
  });
});

describe('computeRunMetrics counts every task attempt', () => {
  function attempt(stageId, index, { runMs, cpuMs, failed = false, killed = false, speculative = false, attemptNumber = 0 }) {
    return JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': stageId, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': index * 10 + attemptNumber + (speculative ? 5 : 0), Index: index, 'Attempt Number': attemptNumber, 'Launch Time': 0, 'Finish Time': runMs, Failed: failed, Killed: killed, Speculative: speculative },
      'Task Metrics': { 'Executor Run Time': runMs, 'Executor CPU Time': cpuMs * 1e6 },
    });
  }

  it('includes a failed attempt that a retry replaced, and a speculative copy that lost', async () => {
    const appModel = await model([
      START,
      ...stageLines(1, 'map', [
        attempt(1, 0, { runMs: 100, cpuMs: 40, failed: true }), // OOM-killed attempt
        attempt(1, 0, { runMs: 50, cpuMs: 20, attemptNumber: 1 }), // its retry
        attempt(1, 1, { runMs: 80, cpuMs: 30 }), // winner
        attempt(1, 1, { runMs: 60, cpuMs: 25, killed: true, speculative: true }), // killed twin
      ]),
      END,
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.time.executorRunTimeMs).toBe(290);
    expect(m.time.executorCpuTimeMs).toBe(115);
    expect(m.shape.taskCount).toBe(2); // tasks, not attempts
    expect(m.shape.failedTasks).toBe(0);
    const row = Object.values(m.stages)[0];
    expect(row.executorRunTimeMs).toBe(290);
    expect(row.executorCpuTimeMs).toBe(115);
    // The stage record the detectors read keeps the winning attempts only.
    expect([...appModel.stages.values()][0].executorRunTime).toBe(130);
  });

  it('includes a losing speculative copy that ends after the stage completed', async () => {
    const appModel = await model([
      START,
      ...stageLines(1, 'map', [attempt(1, 0, { runMs: 80, cpuMs: 30 }), attempt(1, 1, { runMs: 70, cpuMs: 10, speculative: true })]).slice(0, -1),
      JSON.stringify({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Stage Name': 'map', Details: '', 'Number of Tasks': 2, 'Submission Time': 1000, 'Completion Time': 2000 } }),
      attempt(1, 1, { runMs: 90, cpuMs: 45, killed: true }), // the original of index 1, killed after completion
      END,
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.time.executorRunTimeMs).toBe(240);
    expect(m.time.executorCpuTimeMs).toBe(85);
  });
});

describe('computeRunMetrics null contract', () => {
  it('reports null, never 0, for what a cut-off log without CPU time or executors cannot provide', async () => {
    const appModel = await model([START]);
    const m = computeRunMetrics(appModel);
    expect(m.runComplete).toBe(false);
    expect(m.time).toEqual({ wallClockMs: null, executorCpuTimeMs: null, executorRunTimeMs: null, gcTimeMs: null });
    expect(Object.values(m.data).every((v) => v === null)).toBe(true);
    expect(m.shape.taskCount).toBeNull();
    expect(m.shape.maxSkew).toBeNull();
    expect(m.allocation).toEqual({ coreHours: null, memoryGbHours: null });
    expect(m.python.shareOfTaskRunTime).toBeNull();
  });

  it('reports null CPU time for a Spark version whose task metrics carry none, other totals intact', async () => {
    const appModel = await model([START, ...stageLines(1, 'map', [taskEnd(1, 0, { runMs: 100 })]), END]);
    const m = computeRunMetrics(appModel);
    expect(m.time.executorCpuTimeMs).toBeNull();
    expect(m.time.executorRunTimeMs).toBe(100);
    expect(m.data.outputRows).toBeNull(); // no Records Written
    expect(m.data.peakExecutionMemoryBytes).toBeNull();
    expect(Object.values(m.stages)[0].executorCpuTimeMs).toBeNull();
  });

  it('closes executors with no removal at the last event seen when the log is cut off', async () => {
    const appModel = await model([
      env({ 'spark.executor.memory': '2g' }), START, added('1', 0, 2),
      ...stageLines(1, 'map', [taskEnd(1, 0)]), // last event: stage completion at 2000 ms
    ]);
    const m = computeRunMetrics(appModel);
    expect(m.runComplete).toBe(false);
    expect(m.allocation.coreHours).toBeCloseTo((2 * 2000) / 3600000, 10);
    // memory 2048 MiB + max(384, 10%) = 2432 MiB
    expect(m.allocation.memoryGbHours).toBeCloseTo((2432 / GIB * 2000) / 3600000, 10);
  });

  it('leaves allocation null without a core count, and memory null without any Spark properties', () => {
    const appModel = {
      app: makeApp({ endTime: 3600000, config: undefined, resources: { executor: {} } }), sql: new Map(), jobs: new Map(),
      stages: new Map(),
      executors: { added: [{ kind: 'added', executorId: '1', timestamp: 0, totalCores: 0 }], removed: [] },
    };
    expect(computeRunMetrics(appModel).allocation).toEqual({ coreHours: null, memoryGbHours: null });
  });

  it('resolves cores from spark.executor.cores when the event carries none', () => {
    const appModel = {
      app: makeApp({ endTime: 3600000, config: { 'spark.executor.cores': '3' } }), sql: new Map(), jobs: new Map(), stages: new Map(),
      executors: { added: [{ kind: 'added', executorId: '1', timestamp: 0, totalCores: 0 }], removed: [] },
    };
    expect(computeRunMetrics(appModel).allocation.coreHours).toBeCloseTo(3, 10);
  });
});

describe('python share', () => {
  const plan = (nodeName, stageId) => ({ name: 'Project', children: [{ name: nodeName, stageIds: [stageId], children: [] }], stageIds: [stageId] });

  it('is the task run time of Python stages over total task run time, from plan nodes or stage names', () => {
    const appModel = {
      app: makeApp(), jobs: new Map(), executors: { added: [], removed: [] },
      sql: new Map([[7, { id: 7, planTree: plan('BatchEvalPython', 1) }]]),
      stages: new Map([
        [1, makeStage({ id: 1, name: 'collect', sqlExecutionId: 7, executorRunTime: 3000 })],
        [2, makeStage({ id: 2, name: 'PythonRDD lambda', executorRunTime: 1000 })],
        [3, makeStage({ id: 3, name: 'scan', executorRunTime: 4000 })],
      ]),
    };
    const { python, stages } = computeRunMetrics(appModel);
    expect(python).toEqual({ shareOfTaskRunTime: 0.5 });
    expect(Object.values(stages).map((r) => r.python)).toEqual([true, true, false]);
  });
});
