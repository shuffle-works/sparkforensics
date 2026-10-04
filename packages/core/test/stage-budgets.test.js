import { describe, it, expect } from 'vitest';
import { evaluateBudgets } from '../src/cli/budgets.ts';
import { parseStageRegressionBudgetFlag, parseStageQualities } from '../src/cli/regression-budgets.ts';

const appModel = { app: { id: 'a', name: 'n', startTime: 0, endTime: 1000 }, stages: new Map(), executors: { added: [], removed: [] }, evidenceAvailability: { entries: [] } };

function delta(baseline, candidate) {
  return { baseline, candidate, delta: baseline == null || candidate == null ? null : candidate - baseline };
}

function pair(pairId, quality, runTime, extra = {}) {
  const none = delta(0, 0);
  return {
    pairId, quality, score: 1, baseStageIds: [1], candStageIds: [1],
    deltas: {
      executorRunTime: delta(...runTime), executorCpuTime: none, memoryBytesSpilled: none, diskBytesSpilled: none,
      inputBytes: delta(100, 300), outputBytes: none, shuffleReadBytes: none, shuffleWriteBytes: none, ...extra,
    },
  };
}

function run(stagePairs, budgets) {
  const comparison = { metrics: [], findings: { introduced: [], resolved: [] }, stagePairs };
  return evaluateBudgets({ appModel, catalog: [], budgets, comparison });
}

const RUN_TIME_20 = { stageRegressionBudgets: [{ metric: 'executorRunTime', maxPct: 20 }] };

describe('max-stage-regression', () => {
  it('flags a paired stage that regressed beyond the budget and names it', () => {
    const { results, violated } = run([pair('p1', 'exact', [1000, 1100]), pair('p2', 'structural', [1000, 1500])], RUN_TIME_20);
    expect(violated).toBe(true);
    expect(results).toEqual([expect.objectContaining({ name: 'max-stage-regression', metric: 'executorRunTime', status: 'violation' })]);
    expect(results[0].detail).toMatch(/1 of 2 paired stage\(s\).*pair p2 \(structural\) \+50\.0%/);
  });

  it('passes when every paired stage stays within the budget, naming the largest regression', () => {
    const { results, violated, inconclusive } = run([pair('p1', 'exact', [1000, 1100]), pair('p2', 'exact', [1000, 500])], RUN_TIME_20);
    expect([violated, inconclusive]).toEqual([false, false]);
    expect(results[0]).toMatchObject({ status: 'pass' });
    expect(results[0].detail).toMatch(/largest was \+10\.0% \(pair p1\)/);
  });

  it('passes with no regression at all', () => {
    const { results } = run([pair('p1', 'exact', [1000, 900])], RUN_TIME_20);
    expect(results[0]).toMatchObject({ status: 'pass' });
  });

  it('ignores aligned pairs by default and reads them when asked', () => {
    const pairs = [pair('p1', 'exact', [1000, 1000]), pair('p2', 'aligned', [1000, 5000])];
    expect(run(pairs, RUN_TIME_20).results[0].status).toBe('pass');
    expect(run(pairs, { ...RUN_TIME_20, stageQualities: ['exact', 'structural', 'aligned'] }).results[0].status).toBe('violation');
  });

  it('is inconclusive when only aligned pairs exist', () => {
    const { results, inconclusive, violated } = run([pair('p1', 'aligned', [1000, 5000])], RUN_TIME_20);
    expect([violated, inconclusive]).toEqual([false, true]);
    expect(results[0].detail).toMatch(/None of the 1 paired stage/);
  });

  it('is inconclusive when no stage paired', () => {
    expect(run([], RUN_TIME_20).results[0]).toMatchObject({ status: 'inconclusive', detail: 'No stages were paired between the two runs.' });
  });

  it('is inconclusive when the metric is missing on every eligible pair', () => {
    const missing = pair('p1', 'exact', [null, 10]);
    expect(run([missing], RUN_TIME_20).results[0]).toMatchObject({ status: 'inconclusive' });
  });

  it('skips a pair whose metric is missing and judges the rest', () => {
    const { results } = run([pair('p1', 'exact', [null, 10]), pair('p2', 'exact', [100, 200])], RUN_TIME_20);
    expect(results[0]).toMatchObject({ status: 'violation' });
    expect(results[0].detail).toMatch(/1 of 1 paired stage/);
  });

  it('treats growth from a zero baseline as a violation', () => {
    const { results } = run([pair('p1', 'exact', [0, 50])], RUN_TIME_20);
    expect(results[0]).toMatchObject({ status: 'violation' });
    expect(results[0].detail).toMatch(/from 0/);
  });

  it('is inconclusive for a volume metric when called directly', () => {
    const { results } = run([pair('p1', 'exact', [1, 1])], { stageRegressionBudgets: [{ metric: 'inputBytes', maxPct: 5 }] });
    expect(results[0]).toMatchObject({ status: 'inconclusive', metric: 'inputBytes' });
  });

  it('is inconclusive for an unknown metric', () => {
    const { results } = run([pair('p1', 'exact', [1, 1])], { stageRegressionBudgets: [{ metric: 'nope', maxPct: 5 }] });
    expect(results[0]).toMatchObject({ status: 'inconclusive' });
  });

  it('reports one result per budgeted metric', () => {
    const budgets = { stageRegressionBudgets: [{ metric: 'executorRunTime', maxPct: 20 }, { metric: 'diskBytesSpilled', maxPct: 0 }] };
    const { results } = run([pair('p1', 'exact', [1000, 1000], { diskBytesSpilled: delta(10, 20) })], budgets);
    expect(results.map((r) => [r.metric, r.status])).toEqual([['executorRunTime', 'pass'], ['diskBytesSpilled', 'violation']]);
  });

  it('is inconclusive without a baseline comparison', () => {
    const { results } = evaluateBudgets({ appModel, catalog: [], budgets: RUN_TIME_20 });
    expect(results[0]).toMatchObject({ name: 'max-stage-regression', metric: 'executorRunTime', status: 'inconclusive' });
  });

  it('adds nothing when no stage budget is set', () => {
    expect(run([pair('p1', 'exact', [1, 9])], {}).results).toEqual([]);
  });
});

describe('stage budget parsing', () => {
  it('parses <metric>:<pct> over the paired-stage metrics', () => {
    expect(parseStageRegressionBudgetFlag('executorRunTime:12.5')).toEqual({ metric: 'executorRunTime', maxPct: 12.5 });
  });

  it.each(['executorRunTime', 'wallClock:10', 'inputBytes:10', 'outputBytes:10', 'executorRunTime:-1', 'executorRunTime:x'])('rejects %j', (spec) => {
    expect(() => parseStageRegressionBudgetFlag(spec)).toThrow();
  });

  it('parses a quality list and rejects an unknown one', () => {
    expect(parseStageQualities('exact, aligned', 'f')).toEqual(['exact', 'aligned']);
    expect(() => parseStageQualities('exact,loose', 'f')).toThrow(/unknown quality "loose"/);
    expect(() => parseStageQualities('', 'f')).toThrow();
  });
});
