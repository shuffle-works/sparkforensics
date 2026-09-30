import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRegressionBudgetFlag, parseBudgetsFile, loadBudgetsFile, combineRegressionBudgets,
} from '../src/cli/regression-budgets.ts';
import { evaluateBudgets } from '../src/cli/budgets.ts';

describe('parseRegressionBudgetFlag', () => {
  it('parses <metric>:<pct>', () => {
    expect(parseRegressionBudgetFlag('gcTime:12.5')).toEqual({ metric: 'gcTime', maxPct: 12.5 });
    expect(parseRegressionBudgetFlag('wallClock:0')).toEqual({ metric: 'wallClock', maxPct: 0 });
  });

  it.each(['wallClock', 'wallClock:', ':10', 'nope:10', 'wallClock:-1', 'wallClock:1e3', 'wallClock:0x10', 'wallClock: 5', 'wallClock:Infinity', 'wallClock:5%'])(
    'rejects %j', (spec) => { expect(() => parseRegressionBudgetFlag(spec)).toThrow(); },
  );

  it('lists the valid metrics when one is unknown', () => {
    expect(() => parseRegressionBudgetFlag('nope:10')).toThrow(/expected one of: wallClock/);
  });
});

describe('parseBudgetsFile', () => {
  it('parses the regression map in key order', () => {
    expect(parseBudgetsFile({ regression: { wallClock: 10, gcTime: 25.5 } }, 'f')).toEqual([
      { metric: 'wallClock', maxPct: 10 }, { metric: 'gcTime', maxPct: 25.5 },
    ]);
  });

  it.each([
    [null], [[]], ['x'], [{}], [{ regression: [] }], [{ regression: null }],
    [{ regression: {}, extra: 1 }], [{ regression: { nope: 1 } }],
    [{ regression: { wallClock: '10' } }], [{ regression: { wallClock: -1 } }],
    [{ regression: { wallClock: null } }], [{ regression: { wallClock: Infinity } }],
  ])('rejects %j', (raw) => { expect(() => parseBudgetsFile(raw, 'f')).toThrow(/^f:/); });

  it('loadBudgetsFile names the file on a read or JSON failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budgets-'));
    try {
      expect(() => loadBudgetsFile(join(dir, 'missing.json'))).toThrow(/Cannot read budgets file/);
      writeFileSync(join(dir, 'bad.json'), '{');
      expect(() => loadBudgetsFile(join(dir, 'bad.json'))).toThrow(/not valid JSON/);
      writeFileSync(join(dir, 'ok.json'), '{"regression":{"wallClock":5}}');
      expect(loadBudgetsFile(join(dir, 'ok.json'))).toEqual([{ metric: 'wallClock', maxPct: 5 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('combineRegressionBudgets', () => {
  const src = (origin, metric) => ({ origin, budget: { metric, maxPct: 1 } });
  it('refuses a metric budgeted twice, naming both origins', () => {
    expect(() => combineRegressionBudgets([src('--budgets', 'gcTime'), src('--regression-budget', 'gcTime')]))
      .toThrow(/"gcTime".*--budgets and --regression-budget/);
  });
  it('returns distinct budgets', () => {
    expect(combineRegressionBudgets([src('a', 'gcTime'), src('b', 'wallClock')]).map((b) => b.metric)).toEqual(['gcTime', 'wallClock']);
  });
});

function comparison(rows) {
  return { metrics: rows, findings: { introduced: [], resolved: [] } };
}
const row = (key, baseline, candidate, direction) => ({
  key, label: key, baseline, candidate, delta: baseline == null || candidate == null ? null : candidate - baseline, direction,
});

describe('evaluateBudgets regressionBudgets', () => {
  const appModel = { app: { startTime: 0, endTime: 1 }, stages: new Map(), executors: { added: [], removed: [] } };
  const run = (budgets, cmp) => evaluateBudgets({ appModel, catalog: [], budgets, comparison: cmp });

  it('evaluates each budget and tags the result with its metric', () => {
    const cmp = comparison([row('wallClock', 100, 105, 'regression'), row('gcTime', 10, 30, 'regression')]);
    const { results, violated } = run({ regressionBudgets: [{ metric: 'wallClock', maxPct: 10 }, { metric: 'gcTime', maxPct: 10 }] }, cmp);
    expect(results.map((r) => [r.name, r.metric, r.status])).toEqual([
      ['max-regression', 'wallClock', 'pass'], ['max-regression', 'gcTime', 'violation'],
    ]);
    expect(violated).toBe(true);
  });

  it('runs alongside the legacy pair', () => {
    const cmp = comparison([row('wallClock', 100, 105, 'regression'), row('gcTime', 10, 30, 'regression')]);
    const { results } = run({ maxRegressionPct: 10, regressionBudgets: [{ metric: 'gcTime', maxPct: 10 }] }, cmp);
    expect(results.map((r) => [r.metric, r.status])).toEqual([['wallClock', 'pass'], ['gcTime', 'violation']]);
  });

  it('is inconclusive, with its metric, when there is no comparison', () => {
    const { results, inconclusive } = run({ regressionBudgets: [{ metric: 'gcTime', maxPct: 10 }] }, undefined);
    expect(results).toEqual([expect.objectContaining({ name: 'max-regression', metric: 'gcTime', status: 'inconclusive' })]);
    expect(inconclusive).toBe(true);
  });

  it('tags the legacy pair with its metric when there is no comparison', () => {
    expect(run({ maxRegressionPct: 10 }, undefined).results).toEqual([
      expect.objectContaining({ name: 'max-regression', metric: 'wallClock', status: 'inconclusive' }),
    ]);
    expect(run({ maxRegressionPct: 10, regressionMetric: 'gcTime' }, undefined).results[0].metric).toBe('gcTime');
    expect(run({ regressionMetric: 'gcTime' }, undefined).results).toEqual([
      expect.objectContaining({ name: 'max-regression', metric: 'gcTime', status: 'inconclusive' }),
    ]);
  });

  it('is inconclusive, never a pass, for a metric the log could not provide', () => {
    const cmp = comparison([row('gcTime', 10, null, 'unavailable')]);
    const { results } = run({ regressionBudgets: [{ metric: 'gcTime', maxPct: 10 }] }, cmp);
    expect(results[0]).toMatchObject({ metric: 'gcTime', status: 'inconclusive' });
  });
});
