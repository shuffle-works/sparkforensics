import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { evaluateBudgets } from '../src/cli/budgets.js';
import { parseThresholdOverrides } from '../src/threshold-overrides.ts';
import { collectRun } from '../src/cli/collect-run.ts';

async function parsedAppModel(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-budgets-'));
  const path = join(dir, 'eventlog');
  writeFileSync(path, `${lines.join('\n')}\n`);
  try { return (await collectRun(path)).appModel; } finally { rmSync(dir, { recursive: true, force: true }); }
}

function baseAppModel(overrides = {}) {
  return {
    app: { id: 'a', name: 'n', startTime: 0, endTime: 10_000 },
    stages: new Map(),
    executors: { added: [{ executorId: '1', timestamp: 0, totalCores: 4 }], removed: [] },
    runAggregates: { busyCoreMs: 30_000, perStage: { 1: { taskCount: 10, totalTaskDurationSum: 30_000 } } },
    evidenceAvailability: {
      entries: [{ key: 'taskCoreTime', state: 'present', reasonCode: 'observed' }],
    },
    ...overrides,
  };
}

describe('evaluateBudgets', () => {
  it('passes when no budgets are configured', () => {
    const { results, violated } = evaluateBudgets({ appModel: baseAppModel(), catalog: [], budgets: {} });
    expect(results).toEqual([]);
    expect(violated).toBe(false);
  });

  it('flags a runtime violation', () => {
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRuntimeMs: 5_000 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-runtime', status: 'violation' });
  });

  it('passes runtime under budget', () => {
    const { violated } = evaluateBudgets({ appModel: baseAppModel(), catalog: [], budgets: { maxRuntimeMs: 20_000 } });
    expect(violated).toBe(false);
  });

  it('reports runtime inconclusive when the app never ended', () => {
    const appModel = baseAppModel({ app: { id: 'a', name: 'n', startTime: 0, endTime: null } });
    const { results, violated, inconclusive } = evaluateBudgets({ appModel, catalog: [], budgets: { maxRuntimeMs: 1 } });
    expect(violated).toBe(false);
    expect(inconclusive).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-runtime', status: 'inconclusive' });
  });

  it('reports inconclusive false when every budget passes cleanly', () => {
    const { inconclusive } = evaluateBudgets({ appModel: baseAppModel(), catalog: [], budgets: { maxRuntimeMs: 20_000 } });
    expect(inconclusive).toBe(false);
  });

  it('reports both violated and inconclusive when the run has one of each', () => {
    const appModel = baseAppModel({ app: { id: 'a', name: 'n', startTime: 0, endTime: null } });
    appModel.stages = new Map([[1, { id: 1, taskCount: 10, memoryBytesSpilled: 5 * 1024 ** 3 }]]);
    const { violated, inconclusive } = evaluateBudgets({
      appModel, catalog: [], budgets: { maxRuntimeMs: 1, maxSpillGb: 1 },
    });
    expect(violated).toBe(true);
    expect(inconclusive).toBe(true);
  });

  it('reports run-complete inconclusive with no budgets set when the catalog has an incompleteRun finding', () => {
    const catalog = [{ type: 'incompleteRun', impactBand: 'warning', recommendation: 'No ApplicationEnd.' }];
    const { results, violated, inconclusive } = evaluateBudgets({ appModel: baseAppModel(), catalog, budgets: {} });
    expect(results).toEqual([{ name: 'run-complete', status: 'inconclusive', detail: 'No ApplicationEnd.' }]);
    expect(violated).toBe(false);
    expect(inconclusive).toBe(true);
  });

  const GB = 1024 ** 3;

  it('flags a spill violation from the stage spill figures', () => {
    const stages = new Map([[1, { id: 1, taskCount: 10, memoryBytesSpilled: 5 * GB }]]);
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages }), catalog: [], budgets: { maxSpillGb: 1 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-spill', status: 'violation' });
  });

  it('flags a spill violation on a short stage the spill detector floors out of the catalog', () => {
    // 200 GB spilled by a 20 s stage in a 10 h run: no spill finding, but the run broke the budget.
    const stages = new Map([[1, { id: 1, taskCount: 10, submittedAt: 0, completedAt: 20_000, memoryBytesSpilled: 200 * GB }]]);
    const appModel = baseAppModel({ app: { id: 'a', name: 'n', startTime: 0, endTime: 36_000_000 }, stages });
    const { results, violated } = evaluateBudgets({ appModel, catalog: [], budgets: { maxSpillGb: 1 } });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-spill', status: 'violation' });
    expect(results[0].detail).toContain(`Peak stage spill ${200 * GB} bytes`);
  });

  it('passes spill when the peak stage spill is within budget', () => {
    const stages = new Map([[1, { id: 1, taskCount: 10, memoryBytesSpilled: 0.5 * GB }], [2, { id: 2, taskCount: 10, memoryBytesSpilled: 0 }]]);
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages }), catalog: [], budgets: { maxSpillGb: 1 },
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-spill', status: 'pass' });
  });

  it('reports spill inconclusive when no stage carries a spill figure', () => {
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxSpillGb: 1 },
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-spill', status: 'inconclusive' });
  });

  it('flags a skew violation from real stage metrics', () => {
    const stages = new Map([[1, { id: 1, taskCount: 20, taskDurationP50: 100, taskDurationP95: 420, taskDurationMax: 420 }]]);
    const appModel = baseAppModel({ stages });
    const { results, violated } = evaluateBudgets({
      appModel, catalog: [], budgets: { maxSkewRatio: 2 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-skew', status: 'violation' });
  });

  // The detector floors its findings at ratioWarn (3), so a catalog-based
  // check misses budgets stricter than 3; recompute the true ratio from stage
  // metrics to flag a 2.9 ratio against a 2.5 budget.
  it('flags a skew violation below the detector\'s own ratioWarn floor (regression)', () => {
    const stages = new Map([[1, { id: 1, taskCount: 20, taskDurationP50: 100, taskDurationP95: 290, taskDurationMax: 290 }]]);
    const appModel = baseAppModel({ stages });
    const { results, violated } = evaluateBudgets({
      appModel, catalog: [], budgets: { maxSkewRatio: 2.5 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-skew', status: 'violation' });
  });

  it('measures skew with the same tuned minTasksForP95 the skew finding uses', () => {
    // 50 tasks: P95/median 1.5 under the default minTasksForP95 (20), max/median 10 once it is 100.
    const stages = new Map([[1, { id: 1, taskCount: 50, taskDurationP50: 100, taskDurationP95: 150, taskDurationMax: 1000 }]]);
    const appModel = baseAppModel({ stages });
    const budgets = { maxSkewRatio: 5 };
    expect(evaluateBudgets({ appModel, catalog: [], budgets }).violated).toBe(false);
    const thresholds = parseThresholdOverrides({ skew: { minTasksForP95: 100 } });
    const { results, violated } = evaluateBudgets({ appModel, catalog: [], budgets, thresholds });
    expect(violated).toBe(true);
    expect(results[0].detail).toContain('Peak stage skew ratio 10 exceeds budget 5.');
  });

  it('passes skew when the true ratio is within budget', () => {
    const stages = new Map([[1, { id: 1, taskCount: 20, taskDurationP50: 100, taskDurationP95: 150, taskDurationMax: 150 }]]);
    const appModel = baseAppModel({ stages });
    const { violated } = evaluateBudgets({ appModel, catalog: [], budgets: { maxSkewRatio: 2 } });
    expect(violated).toBe(false);
  });

  it('ignores a stage with no task-duration median instead of reporting a NaN peak', () => {
    const stages = new Map([
      [1, { id: 1, taskCount: 20, taskDurationP50: 100, taskDurationP95: 1000, taskDurationMax: 1000 }],
      [2, { id: 2 }],
    ]);
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages }), catalog: [], budgets: { maxSkewRatio: 5 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-skew', status: 'violation' });
    expect(results[0].detail).toContain('Peak stage skew ratio 10 exceeds budget 5.');
  });

  it('reports skew inconclusive when every stage lacks a usable ratio', () => {
    const stages = new Map([[1, { id: 1 }], [2, { id: 2, taskCount: 20, taskDurationP50: 100 }]]);
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages }), catalog: [], budgets: { maxSkewRatio: 5 },
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-skew', status: 'inconclusive' });
  });

  it('reports skew inconclusive when there are no stages', () => {
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages: new Map() }), catalog: [], budgets: { maxSkewRatio: 2 },
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-skew', status: 'inconclusive' });
  });

  it('reports skew inconclusive when no stage has a measurable p50', () => {
    const stages = new Map([[1, { id: 1, taskCount: 20, taskDurationP50: 0, taskDurationP95: 0, taskDurationMax: 0 }]]);
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages }), catalog: [], budgets: { maxSkewRatio: 2 },
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-skew', status: 'inconclusive' });
  });

  it('flags a failed-task-rate violation from the summed stage task counts', () => {
    const stages = new Map([[1, { id: 1, taskCount: 60, failedTasks: 20 }], [2, { id: 2, taskCount: 40, failedTasks: 20 }]]);
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages }), catalog: [], budgets: { maxFailedTaskRatePct: 20 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-failed-task-rate', status: 'violation' });
    expect(results[0].detail).toContain('Task failure rate 40%');
  });

  it('flags retried task failures when every job succeeded and no jobFailureRate finding fired', async () => {
    const taskEnd = (index, attemptNumber, failed) => JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': index * 10 + attemptNumber, Index: index, 'Attempt Number': attemptNumber, 'Launch Time': 0, 'Finish Time': 100, Failed: failed, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': 100 },
    });
    const tasks = Array.from({ length: 100 }, (_, i) => (i < 25 ? [taskEnd(i, 0, true), taskEnd(i, 1, false)] : [taskEnd(i, 0, false)])).flat();
    const stageInfo = { 'Stage ID': 1, 'Stage Name': 'map', 'Number of Tasks': 100, 'Submission Time': 1000 };
    const appModel = await parsedAppModel([
      JSON.stringify({ Event: 'SparkListenerApplicationStart', 'App ID': 'application_0000000000000_0001', 'App Name': 't', Timestamp: 0 }),
      JSON.stringify({ Event: 'SparkListenerJobStart', 'Job ID': 1, 'Submission Time': 0, 'Stage IDs': [1] }),
      JSON.stringify({ Event: 'SparkListenerStageSubmitted', 'Stage Info': stageInfo }),
      ...tasks,
      JSON.stringify({ Event: 'SparkListenerStageCompleted', 'Stage Info': { ...stageInfo, 'Completion Time': 2000 } }),
      JSON.stringify({ Event: 'SparkListenerJobEnd', 'Job ID': 1, 'Completion Time': 2000, 'Job Result': { Result: 'JobSucceeded' } }),
      JSON.stringify({ Event: 'SparkListenerApplicationEnd', Timestamp: 3000 }),
    ]);
    const { results, violated } = evaluateBudgets({ appModel, catalog: [], budgets: { maxFailedTaskRatePct: 1 } });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-failed-task-rate', status: 'violation' });
    expect(results[0].detail).toContain('Task failure rate 20%');
  });

  it('flags a failed-task rate that rounds to 0% against a zero budget', () => {
    const stages = new Map([[1, { id: 1, taskCount: 3000, failedTasks: 1 }]]);
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages }), catalog: [], budgets: { maxFailedTaskRatePct: 0 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-failed-task-rate', status: 'violation' });
  });

  it('reports failed-task-rate inconclusive when no stage ran a task', () => {
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages: new Map([[1, { id: 1, taskCount: 0 }]]) }), catalog: [], budgets: { maxFailedTaskRatePct: 20 },
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-failed-task-rate', status: 'inconclusive' });
  });

  it('passes failed-task-rate when the task failure rate is within budget', () => {
    const stages = new Map([[1, { id: 1, taskCount: 100, failedTasks: 5 }]]);
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel({ stages }), catalog: [], budgets: { maxFailedTaskRatePct: 20 },
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-failed-task-rate', status: 'pass' });
  });

  it('flags an efficiency violation via computeEfficiencyModel', () => {
    // Empty `stages` makes computeWallClock treat the whole 10s as idle, so
    // efficiency is 0% regardless of busyCoreMs, below any minEfficiencyPct.
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { minEfficiencyPct: 90 },
    });
    expect(violated).toBe(true);
    // Worded as busy core time, so it never reads as the dashboard's Efficiency tile.
    expect(results[0]).toMatchObject({ name: 'min-efficiency', status: 'violation', detail: 'Busy core time 0% below budget 90%.' });
  });

  it('measures busy core time against peak concurrent cores when an executor was replaced', () => {
    // Executor 1 leaves at 5s as its same-size replacement joins: 4 cores are ever concurrent,
    // so 20s of busy core time is 50%, not the 25% a sum of every addition would give.
    const appModel = baseAppModel({
      stages: new Map([[1, { id: 1, submittedAt: 0, completedAt: 10_000 }]]),
      executors: {
        added: [{ executorId: '1', timestamp: 0, totalCores: 4 }, { executorId: '2', timestamp: 5_000, totalCores: 4 }],
        removed: [{ executorId: '1', timestamp: 5_000 }],
      },
      runAggregates: { busyCoreMs: 20_000, perStage: { 1: { taskCount: 10, totalTaskDurationSum: 20_000 } } },
    });
    const { results, violated } = evaluateBudgets({ appModel, catalog: [], budgets: { minEfficiencyPct: 50 } });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'min-efficiency', status: 'pass', detail: 'Busy core time 50% meets budget 50%.' });
  });

  it('reports efficiency inconclusive when taskCoreTime evidence is absent', () => {
    const appModel = baseAppModel({
      evidenceAvailability: { entries: [{ key: 'taskCoreTime', state: 'unknown', reasonCode: 'parseIncomplete' }] },
    });
    const { results, violated } = evaluateBudgets({ appModel, catalog: [], budgets: { minEfficiencyPct: 90 } });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'min-efficiency', status: 'inconclusive' });
  });

  function baseComparison(overrides = {}) {
    return {
      baselineLabel: 'baseline', candidateLabel: 'candidate',
      confidence: 'ok', reason: null, matchedCoverage: 1,
      metrics: [
        { key: 'wallClock', label: 'Wall-clock duration', baseline: 10_000, candidate: 12_000, delta: 2_000, direction: 'regression' },
      ],
      findings: { introduced: [], resolved: [], changed: [] },
      stageSkew: [], baseStages: [], candStages: [],
      ...overrides,
    };
  }

  it('flags a max-regression violation when the metric regressed beyond budget', () => {
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 10 }, comparison: baseComparison(),
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'violation' });
  });

  it('passes max-regression when the regression is within budget', () => {
    const { violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 30 }, comparison: baseComparison(),
    });
    expect(violated).toBe(false);
  });

  it('passes max-regression when the metric improved instead of regressing', () => {
    const comparison = baseComparison({
      metrics: [{ key: 'wallClock', label: 'Wall-clock duration', baseline: 10_000, candidate: 8_000, delta: -2_000, direction: 'improvement' }],
    });
    const { violated, results } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 5 }, comparison,
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'pass' });
  });

  it('checks a non-default --regression-metric key', () => {
    const comparison = baseComparison({
      metrics: [
        { key: 'wallClock', label: 'Wall-clock duration', baseline: 10_000, candidate: 10_000, delta: 0, direction: 'unchanged' },
        { key: 'shuffleSpill', label: 'Memory spill', baseline: 100, candidate: 200, delta: 100, direction: 'regression' },
      ],
    });
    const { violated, results } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 50, regressionMetric: 'shuffleSpill' }, comparison,
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'violation' });
  });

  it('reports max-regression inconclusive when the metric row is missing', () => {
    const comparison = baseComparison({ metrics: [] });
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 10 }, comparison,
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'inconclusive' });
  });

  it('reports max-regression inconclusive (not a false violation) for a neutral-direction metric like inputBytes', () => {
    const comparison = baseComparison({
      metrics: [{ key: 'inputBytes', label: 'Input read', baseline: 1000, candidate: 2000, delta: 1000, direction: 'neutral' }],
    });
    const { violated, results } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 10, regressionMetric: 'inputBytes' }, comparison,
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'inconclusive' });
  });

  it('reports max-regression inconclusive instead of silently skipping when regressionMetric is set without maxRegressionPct', () => {
    const { results, violated, inconclusive } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { regressionMetric: 'shuffleSpill' }, comparison: baseComparison(),
    });
    expect(violated).toBe(false);
    expect(inconclusive).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'inconclusive' });
  });

  it('flags a max-regression violation without percentage math when the baseline metric is zero', () => {
    const comparison = baseComparison({
      metrics: [{ key: 'wallClock', label: 'Wall-clock duration', baseline: 0, candidate: 500, delta: 500, direction: 'regression' }],
    });
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 10 }, comparison,
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'violation' });
    expect(results[0].detail).not.toMatch(/Infinity/);
  });

  it('passes a zero-baseline regression when maxRegressionPct is set high enough (unlimited)', () => {
    // A zero-baseline regression's pct is Infinity, so only an unlimited
    // (Infinity) budget passes; any finite budget still violates.
    const comparison = baseComparison({
      metrics: [{ key: 'wallClock', label: 'Wall-clock duration', baseline: 0, candidate: 500, delta: 500, direction: 'regression' }],
    });
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: Infinity }, comparison,
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'pass' });
  });

  it('reports max-regression inconclusive when the metric is unavailable', () => {
    const comparison = baseComparison({
      metrics: [{ key: 'wallClock', label: 'Wall-clock duration', baseline: null, candidate: null, delta: null, direction: 'unavailable' }],
    });
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 10 }, comparison,
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-regression', status: 'inconclusive' });
  });

  it('flags a fail-on-introduced violation for a matching impact band', () => {
    const comparison = baseComparison({
      findings: { introduced: [{ rule: 'spill', impactBand: 'critical', baseCount: 0, candCount: 1, delta: 1, stages: ['s1'] }], resolved: [], changed: [] },
    });
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { failOnIntroduced: 'critical' }, comparison,
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'fail-on-introduced', status: 'violation' });
  });

  it('passes fail-on-introduced when no introduced finding matches the band', () => {
    const comparison = baseComparison({
      findings: { introduced: [{ rule: 'spill', impactBand: 'warning', baseCount: 0, candCount: 1, delta: 1, stages: ['s1'] }], resolved: [], changed: [] },
    });
    const { violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { failOnIntroduced: 'critical' }, comparison,
    });
    expect(violated).toBe(false);
  });

  it('flags fail-on-introduced "all" for any introduced finding regardless of band', () => {
    const comparison = baseComparison({
      findings: { introduced: [{ rule: 'spill', impactBand: 'info', baseCount: 0, candCount: 1, delta: 1, stages: ['s1'] }], resolved: [], changed: [] },
    });
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { failOnIntroduced: 'all' }, comparison,
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'fail-on-introduced', status: 'violation' });
  });

  it('reports fail-on-introduced inconclusive for an unrecognized impact band', () => {
    const comparison = baseComparison({
      findings: { introduced: [{ rule: 'spill', impactBand: 'critical', baseCount: 0, candCount: 1, delta: 1, stages: ['s1'] }], resolved: [] },
    });
    const { results, violated, inconclusive } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { failOnIntroduced: 'criticall' }, comparison,
    });
    expect(violated).toBe(false);
    expect(inconclusive).toBe(true);
    expect(results[0]).toMatchObject({ name: 'fail-on-introduced', status: 'inconclusive' });
  });

  it('reports the comparison-gated checks inconclusive when comparison is not provided', () => {
    const { results, violated, inconclusive } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { maxRegressionPct: 10, failOnIntroduced: 'critical' },
    });
    expect(violated).toBe(false);
    expect(inconclusive).toBe(true);
    expect(results).toMatchObject([
      { name: 'max-regression', status: 'inconclusive' },
      { name: 'fail-on-introduced', status: 'inconclusive' },
    ]);
  });
});
