import { describe, it, expect } from 'vitest';
import { evaluateBudgets } from '../src/cli/budgets.js';

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
    const catalog = [{ type: 'spill', stageId: 1, impactBand: 'critical', value: 5 * 1024 ** 3 }];
    const { violated, inconclusive } = evaluateBudgets({
      appModel, catalog, budgets: { maxRuntimeMs: 1, maxSpillGb: 1 },
    });
    expect(violated).toBe(true);
    expect(inconclusive).toBe(true);
  });

  it('flags a spill violation from the finding catalog', () => {
    const catalog = [{ type: 'spill', stageId: 1, impactBand: 'critical', value: 5 * 1024 ** 3 }];
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog, budgets: { maxSpillGb: 1 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-spill', status: 'violation' });
  });

  it('passes spill when no spill finding exceeds budget', () => {
    const { violated } = evaluateBudgets({ appModel: baseAppModel(), catalog: [], budgets: { maxSpillGb: 1 } });
    expect(violated).toBe(false);
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

  it('passes skew when the true ratio is within budget', () => {
    const stages = new Map([[1, { id: 1, taskCount: 20, taskDurationP50: 100, taskDurationP95: 150, taskDurationMax: 150 }]]);
    const appModel = baseAppModel({ stages });
    const { violated } = evaluateBudgets({ appModel, catalog: [], budgets: { maxSkewRatio: 2 } });
    expect(violated).toBe(false);
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

  it('flags a failed-task-rate violation using taskFailureRate, not the job-rate value', () => {
    const catalog = [{ type: 'jobFailureRate', value: 15, taskFailureRate: 40 }];
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog, budgets: { maxFailedTaskRatePct: 20 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'max-failed-task-rate', status: 'violation' });
  });

  it('reports failed-task-rate inconclusive when there is no job data at all', () => {
    const appModel = baseAppModel({ jobs: new Map() });
    const { results, violated } = evaluateBudgets({
      appModel, catalog: [], budgets: { maxFailedTaskRatePct: 20 },
    });
    expect(violated).toBe(false);
    expect(results[0]).toMatchObject({ name: 'max-failed-task-rate', status: 'inconclusive' });
  });

  it('passes failed-task-rate when jobs exist but no jobFailureRate finding fired', () => {
    const appModel = baseAppModel({ jobs: new Map([[1, { id: 1, result: 'JobSucceeded', succeeded: true }]]) });
    const { violated } = evaluateBudgets({ appModel, catalog: [], budgets: { maxFailedTaskRatePct: 20 } });
    expect(violated).toBe(false);
  });

  it('flags an efficiency violation via computeEfficiencyModel', () => {
    // Empty `stages` makes computeWallClock treat the whole 10s as idle, so
    // efficiency is 0% regardless of busyCoreMs, below any minEfficiencyPct.
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { minEfficiencyPct: 90 },
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'min-efficiency', status: 'violation' });
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
      findings: { introduced: [], resolved: [] },
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
        { key: 'shuffleSpill', label: 'Shuffle spill', baseline: 100, candidate: 200, delta: 100, direction: 'regression' },
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
      findings: { introduced: [{ rule: 'spill', impactBand: 'critical', baseCount: 0, candCount: 1, delta: 1, stages: ['s1'] }], resolved: [] },
    });
    const { results, violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { failOnIntroduced: 'critical' }, comparison,
    });
    expect(violated).toBe(true);
    expect(results[0]).toMatchObject({ name: 'fail-on-introduced', status: 'violation' });
  });

  it('passes fail-on-introduced when no introduced finding matches the band', () => {
    const comparison = baseComparison({
      findings: { introduced: [{ rule: 'spill', impactBand: 'warning', baseCount: 0, candCount: 1, delta: 1, stages: ['s1'] }], resolved: [] },
    });
    const { violated } = evaluateBudgets({
      appModel: baseAppModel(), catalog: [], budgets: { failOnIntroduced: 'critical' }, comparison,
    });
    expect(violated).toBe(false);
  });

  it('flags fail-on-introduced "all" for any introduced finding regardless of band', () => {
    const comparison = baseComparison({
      findings: { introduced: [{ rule: 'spill', impactBand: 'info', baseCount: 0, candCount: 1, delta: 1, stages: ['s1'] }], resolved: [] },
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
