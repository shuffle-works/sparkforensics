import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyzer.js';
import { collectRun } from '../src/cli/collect-run.ts';
import { isBatchEvalPythonNode } from '../src/python-stage.ts';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

const MB = 1024 * 1024;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'python-udf-spark-3.5.9.ndjson');
const ARROW_KEY = 'spark.sql.execution.pythonUDF.arrow.enabled';

const pythonNode = (name, sent, returned, stageIds = [1]) => ({
  id: 'n1', name, detail: '', children: [], stageIds,
  metrics: [
    ...(sent == null ? [] : [{ name: 'data sent to Python workers', value: sent, metricType: 'size', executorSide: true }]),
    ...(returned == null ? [] : [{ name: 'data returned from Python workers', value: returned, metricType: 'size', executorSide: true }]),
  ],
});

// One execution over stage 1, which ran for `durationMs`.
function run({ node = pythonNode('BatchEvalPython', 200 * MB, 50 * MB), durationMs = 60_000, app = makeApp({ endTime: 120_000 }), thresholds } = {}) {
  const planTree = { id: 'root', name: 'Project', detail: '', children: [node] };
  const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: durationMs, stageIds: [1], planTree }]]);
  const stages = new Map([[1, makeStage({ sqlExecutionId: 1, completedAt: durationMs })]]);
  return analyze(app, stages, [], [], new Map(), sql, null, { thresholds }).filter((f) => f.type === 'pythonUdf');
}

describe('pythonUdf', () => {
  it('flags a row-at-a-time UDF stage with the bytes both ways and the stage time', () => {
    const [finding, ...rest] = run();
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      impactBand: 'info', executionId: 1, stageIds: [1], planNodeIds: ['n1'],
      metric: 'dataSentBytes', value: 200 * MB, dataSentBytes: 200 * MB, dataReturnedBytes: 50 * MB, stageDurationMs: 60_000,
    });
    expect(finding.recommendation).toContain('sent 210 MB to Python workers and received 52 MB back over 1m 0s');
    expect(finding.remediation).toEqual([{ kind: 'conf', key: ARROW_KEY, direction: 'set', suggested: true }]);
  });

  it('does not flag ArrowEvalPython, which Arrow-optimized and pandas UDFs run in', () => {
    expect(run({ node: pythonNode('ArrowEvalPython', 200 * MB, 50 * MB) })).toEqual([]);
    expect(run({ node: pythonNode('BatchEvalPythonUDTF', 200 * MB, 50 * MB) })).toEqual([]);
  });

  it('matches BatchEvalPython under a whole-stage-codegen prefix only', () => {
    expect(isBatchEvalPythonNode({ name: 'BatchEvalPython' })).toBe(true);
    expect(isBatchEvalPythonNode({ name: '*(2) BatchEvalPython' })).toBe(true);
    expect(isBatchEvalPythonNode({ name: 'ArrowEvalPython' })).toBe(false);
  });

  it('stays quiet under the byte and stage-time floors, and without the executor-side metric', () => {
    expect(run({ node: pythonNode('BatchEvalPython', 10 * MB, 10 * MB) })).toEqual([]);
    expect(run({ durationMs: 10_000 })).toEqual([]);
    expect(run({ node: pythonNode('BatchEvalPython', null, null) })).toEqual([]);
    expect(run({ node: pythonNode('BatchEvalPython', 200 * MB, null, []) })).toEqual([]);
  });

  it('reports the sent bytes alone when the plan has no returned-bytes metric', () => {
    const [finding] = run({ node: pythonNode('BatchEvalPython', 200 * MB, null) });
    expect(finding.dataReturnedBytes).toBeNull();
    expect(finding.recommendation).toContain('sent 210 MB to Python workers over 1m 0s');
    expect(finding.recommendation).not.toContain('received');
  });

  it('applies tuned thresholds', () => {
    expect(run({ durationMs: 10_000, thresholds: { pythonUdf: { minStageMs: 5_000 } } })).toHaveLength(1);
  });

  describe('fix by Spark version and conf', () => {
    const fixOf = (config, sparkVersion) => run({ app: makeApp({ endTime: 120_000, config, sparkVersion }) })[0];

    it('leaves the property out when the run already enabled it', () => {
      const finding = fixOf({ [ARROW_KEY]: 'TRUE' }, '3.5.9');
      expect(finding.remediation).toEqual([]);
      expect(finding.recommendation).toContain('useArrow=False');
    });

    it('leaves the property out where Spark defaults it on (4.2 and later)', () => {
      expect(fixOf({}, '4.2.0').remediation).toEqual([]);
      expect(fixOf({}, '4.0.4').remediation).toHaveLength(1);
    });
  });

  // A log from apache/spark:3.5.9 running one Python UDF over 2M rows in local[2] (2.4 s of stage time).
  it('reads the executor-side Python metrics of a real log', async () => {
    const { appModel } = await collectRun(FIXTURE);
    const find = (thresholds) => analyze(appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed, appModel.jobs, appModel.sql, null, { thresholds })
      .filter((f) => f.type === 'pythonUdf');
    expect(find()).toEqual([]); // far below the default floors
    const [finding] = find({ pythonUdf: { minBytesSent: 0, minStageMs: 0 } });
    expect(finding).toMatchObject({ dataSentBytes: 12048680, dataReturnedBytes: 14113810, stageIds: [0] });
  });
});
