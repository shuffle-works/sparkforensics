import { describe, it, expect } from 'vitest';
import { isPythonStage } from '../src/python-stage.ts';
import { tasksMostlyIdle } from '../src/impact-model.ts';
import { analyze } from '../src/analyzer.ts';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

const sqlWith = (nodeName, stageId, execId = 1) => new Map([[execId, {
  id: execId,
  planTree: { name: 'Project', stageIds: [stageId], children: [{ name: nodeName, detail: '', stageIds: [stageId], children: [] }] },
}]]);

describe('isPythonStage', () => {
  it.each([
    'BatchEvalPython', 'ArrowEvalPython', 'PythonRDD', 'FlatMapGroupsInPandas', 'MapInPandas', 'PythonMapInArrow',
    'BatchEvalPythonUDTF', 'ArrowEvalPythonUDTF', 'FlatMapGroupsInPandasWithState', '*(2) ArrowEvalPython',
    'ArrowAggregatePython', 'ArrowWindowPython', 'AggregateInPandas', 'WindowInPandas',
  ])(
    'matches a %s plan node attributed to the stage', (node) => {
      expect(isPythonStage(makeStage({ id: 4, sqlExecutionId: 1 }), sqlWith(node, 4))).toBe(true);
    });

  it('ignores a Python node attributed to a different stage of the same execution', () => {
    expect(isPythonStage(makeStage({ id: 5, sqlExecutionId: 1 }), sqlWith('BatchEvalPython', 4))).toBe(false);
  });

  it('matches the stage name or call site when there is no plan to match', () => {
    expect(isPythonStage(makeStage({ name: 'PythonRDD at lambda' }), new Map())).toBe(true);
    expect(isPythonStage(makeStage({ name: 'collect', details: 'org.apache.spark.api.python.PythonRDD.collectAndServe' }), new Map())).toBe(true);
    expect(isPythonStage(makeStage({ name: 'collect at A.scala:1' }), new Map())).toBe(false);
  });

  it('unions both signals: a plan with no Python node still counts on the name', () => {
    expect(isPythonStage(makeStage({ id: 4, sqlExecutionId: 1, name: 'PythonRDD x' }), sqlWith('Scan parquet', 4))).toBe(true);
  });
});

describe('tasksMostlyIdle with Python plan nodes', () => {
  const idle = (over) => makeStage({ executorRunTime: 10_000, executorCpuTime: 1e6, ...over }); // 0.01% CPU share

  it('is true for a non-Python stage with a near-zero CPU share', () => {
    expect(tasksMostlyIdle(idle({ id: 4, sqlExecutionId: 1 }), sqlWith('Scan parquet', 4))).toBe(true);
  });

  it('is false for a stage running a SQL Python UDF, whose worker CPU the metric misses', () => {
    expect(tasksMostlyIdle(idle({ id: 4, sqlExecutionId: 1 }), sqlWith('BatchEvalPython', 4))).toBe(false);
  });

  it('still reads the stage name and call site without a plan', () => {
    expect(tasksMostlyIdle(idle({ name: 'PythonRDD at x' }))).toBe(false);
  });

  it('drops the "mostly idle" zero-waste claim on a stage running a SQL Python UDF', () => {
    const run = (nodeName) => {
      const stage = idle({
        id: 4, sqlExecutionId: 1, taskCount: 1, inputBytes: 0, shuffleReadBytes: 0,
        submittedAt: 0, completedAt: 1_200_000, taskActiveMs: 1_200_000, taskDurationP50: 1_200_000, taskDurationP95: 1_200_000, taskDurationMax: 1_200_000,
        executorRunTime: 1_200_000, executorCpuTime: 1e6,
      });
      const added = Array.from({ length: 8 }, (_, i) => ({ kind: 'added', executorId: `${i}`, timestamp: 0, totalCores: 4 }));
      const findings = analyze(makeApp({ endTime: 1_200_000 }), new Map([[4, stage]]), added, [], new Map(), sqlWith(nodeName, 4));
      return findings.filter((f) => f.type === 'stageSlowness').map((f) => f.impactEstimate?.rawWaste?.value ?? 0);
    };
    const plain = run('Scan parquet');
    const udf = run('BatchEvalPython');
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((w) => w === 0)).toBe(true);
    expect(udf.some((w) => w > 0)).toBe(true);
  });
});
