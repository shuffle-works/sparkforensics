import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, dispatchLine, resolvePlanTree } from '../src/event-handlers.ts';
import { computePlanShapes } from '../src/detectors.ts';
import { collectRun } from '../src/cli/collect-run.ts';
import { walkPlanTree } from '../src/plan-tree-walk.ts';

const SQL = 'org.apache.spark.sql.execution.ui.SparkListener';
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs');

// One execution: Project over an Exchange over a Scan. The Exchange's `data size` and the scan's
// `number of output rows` are executor-side (task updates); the scan's `number of files read` is
// driver-side (SparkListenerDriverAccumUpdates).
const planInfo = {
  nodeName: 'Project',
  simpleString: 'Project [id]',
  children: [{
    nodeName: 'Exchange',
    simpleString: 'Exchange hashpartitioning(id, 200)',
    children: [{
      nodeName: 'Scan parquet t',
      simpleString: 'Scan parquet t',
      children: [],
      metrics: [
        { name: 'number of output rows', accumulatorId: 11, metricType: 'sum' },
        { name: 'number of files read', accumulatorId: 12, metricType: 'sum' },
      ],
    }],
    metrics: [
      { name: 'data size', accumulatorId: 21, metricType: 'size' },
      { name: 'avg probes', accumulatorId: 22, metricType: 'average' },
    ],
  }],
  metrics: [],
};

const sqlAccumulable = (id, name, value) => ({ ID: id, Name: name, Value: value, Internal: true, 'Count Failed Values': true, Metadata: 'sql' });

function run(lines) {
  const state = createState();
  const messages = [];
  for (const line of lines) dispatchLine(JSON.stringify(line), state, (m) => messages.push(m));
  return messages;
}

const execStart = { Event: `${SQL}SQLExecutionStart`, executionId: 0, description: 'q', physicalPlanDescription: '', sparkPlanInfo: planInfo, time: 1 };
const jobStart = (jobId, stageId) => ({
  Event: 'SparkListenerJobStart', 'Job ID': jobId, 'Submission Time': 2, 'Stage IDs': [stageId], Properties: { 'spark.sql.execution.id': '0' },
});
const stageSubmitted = (id) => ({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': id, 'Stage Attempt ID': 0, 'Number of Tasks': 1, 'Submission Time': 3 } });
const stageCompleted = (id, accumulables) => ({
  Event: 'SparkListenerStageCompleted',
  'Stage Info': { 'Stage ID': id, 'Stage Attempt ID': 0, 'Number of Tasks': 1, 'Submission Time': 3, 'Completion Time': 9, Accumulables: accumulables },
});
const execEnd = { Event: `${SQL}SQLExecutionEnd`, executionId: 0, time: 10 };

function resolvedPlan(lines) {
  const sqlPlan = run(lines).find((m) => m.type === 'sqlPlan');
  expect(sqlPlan).toBeDefined();
  return sqlPlan.data.planTree;
}

function metricsOf(tree, name) {
  let found;
  walkPlanTree(tree, (n) => { if (n.name === name && (!n.exchangeRole || n.exchangeRole === 'write')) found = n.metrics; });
  return found;
}

describe('executor-side SQL metric values', () => {
  it('reads an Exchange data size from the StageCompleted accumulables', () => {
    const tree = resolvedPlan([
      execStart, jobStart(0, 0), stageSubmitted(0),
      stageCompleted(0, [sqlAccumulable(11, 'number of output rows', '1000'), sqlAccumulable(21, 'data size', '96000000')]),
      execEnd,
    ]);
    expect(metricsOf(tree, 'Exchange')).toEqual([{ name: 'data size', value: 96000000, metricType: 'size', executorSide: true }]);
    expect(metricsOf(tree, 'Scan parquet t')).toEqual([{ name: 'number of output rows', value: 1000, metricType: 'sum', executorSide: true }]);
  });

  it('keeps the latest running total when later stages report the same accumulator', () => {
    const tree = resolvedPlan([
      execStart, jobStart(0, 0), stageSubmitted(0),
      stageCompleted(0, [sqlAccumulable(21, 'data size', '40')]),
      jobStart(1, 1), stageSubmitted(1),
      stageCompleted(1, [sqlAccumulable(21, 'data size', '100')]),
      execEnd,
    ]);
    expect(metricsOf(tree, 'Exchange')[0].value).toBe(100);
  });

  it('prefers a driver-side value over an executor-side one', () => {
    const tree = resolvedPlan([
      execStart,
      { Event: `${SQL}DriverAccumUpdates`, executionId: 0, accumUpdates: [[12, 7], [21, 5]] },
      jobStart(0, 0), stageSubmitted(0),
      stageCompleted(0, [sqlAccumulable(21, 'data size', '96000000')]),
      execEnd,
    ]);
    expect(metricsOf(tree, 'Exchange')).toEqual([{ name: 'data size', value: 5, metricType: 'size' }]);
    expect(metricsOf(tree, 'Scan parquet t')).toEqual([{ name: 'number of files read', value: 7, metricType: 'sum' }]);
  });

  it('ignores average metrics, non-SQL accumulators, stages outside any execution and unparsable values', () => {
    const tree = resolvedPlan([
      execStart, jobStart(0, 0), stageSubmitted(0),
      stageSubmitted(5),
      stageCompleted(5, [sqlAccumulable(21, 'data size', '1')]),
      stageCompleted(0, [
        sqlAccumulable(22, 'avg probes', '30'),
        { ID: 21, Name: 'data size', Value: '96', Internal: true },
        sqlAccumulable(11, 'number of output rows', 'n/a'),
        sqlAccumulable(12, 'number of files read', ['1']),
      ]),
      execEnd,
    ]);
    expect(metricsOf(tree, 'Exchange')).toEqual([]);
    expect(metricsOf(tree, 'Scan parquet t')).toEqual([]);
  });

  it('is a no-op for stage events without accumulables', () => {
    const tree = resolvedPlan([
      execStart, jobStart(0, 0), stageSubmitted(0), stageCompleted(0, undefined), execEnd,
    ]);
    expect(metricsOf(tree, 'Exchange')).toEqual([]);
  });

  it('does not leak totals past the execution end', () => {
    const state = createState();
    const emit = () => {};
    for (const line of [execStart, jobStart(0, 0), stageSubmitted(0), stageCompleted(0, [sqlAccumulable(21, 'data size', '9')]), execEnd]) {
      dispatchLine(JSON.stringify(line), state, emit);
    }
    expect(state.executorAccumState.size).toBe(0);
  });
});

describe('resolvePlanTree: executor-side map', () => {
  const raw = (metrics) => ({ nodeName: 'Sort', simpleString: 'Sort', children: [], metrics });

  it('falls back to the executor-side map only for accumulators the driver map lacks', () => {
    const tree = resolvePlanTree(
      raw([
        { name: 'peak memory', accumulatorId: 1, metricType: 'size' },
        { name: 'spill size', accumulatorId: 2, metricType: 'size' },
        { name: 'sort time', accumulatorId: 3, metricType: 'timing' },
      ]),
      new Map([[2, 5]]), new Map(), undefined, 0, new Map([[1, 402653056], [2, 99]]),
    );
    expect(tree.metrics).toEqual([
      { name: 'peak memory', value: 402653056, metricType: 'size', executorSide: true },
      { name: 'spill size', value: 5, metricType: 'size' },
    ]);
  });
});

describe('plan fingerprints', () => {
  const node = (metrics, children = []) => ({ name: 'Exchange', metrics, children });

  it('ignore executor-side metrics, so ids derived from them do not shift', () => {
    const driverOnly = node([{ name: 'number of partitions', value: 4 }]);
    const withExecutor = node([
      { name: 'number of partitions', value: 4 },
      { name: 'data size', value: 96, executorSide: true },
    ]);
    const a = computePlanShapes(driverOnly).shapeOf.get(driverOnly).fingerprint;
    const b = computePlanShapes(withExecutor).shapeOf.get(withExecutor).fingerprint;
    expect(b).toBe(a);
  });
});

describe('public corpus', () => {
  const logs = ['spark-3.5-parquet-baseline', 'spark-4.0-parquet-baseline', 'spark-4.1-parquet-baseline', 'spark-4.2-parquet-baseline'];
  for (const name of logs) {
    it.skipIf(!existsSync(join(CORPUS_DIR, `${name}.ndjson`)))(`${name}: every shuffle Exchange resolves a non-zero data size`, async () => {
      const { appModel } = await collectRun(join(CORPUS_DIR, `${name}.ndjson`));
      const sizes = [];
      for (const exec of appModel.sql.values()) {
        if (!exec.planTree) continue;
        walkPlanTree(exec.planTree, (n) => {
          if (n.name === 'Exchange' && n.exchangeRole === 'write') sizes.push(n.metrics.find((m) => m.name === 'data size')?.value);
        });
      }
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.every((v) => typeof v === 'number' && v > 0)).toBe(true);
    });
  }
});
