import { describe, it, expect } from 'vitest';
import { findingKey, diffFindings } from '../src/finding-identity.ts';
import { compareRuns } from '../src/run-comparison.ts';
import { comparisonVerdict } from '../src/comparison-verdict.ts';
import { evaluateBudgets } from '../src/cli/budgets.ts';

const APP = { id: 'a', name: 'job', startTime: 0, endTime: 10_000 };

function stage(name) {
  return { name, details: name, sqlExecutionId: null, submittedAt: 0, completedAt: 1000, taskDurationMax: 100,
    taskCount: 10, failedTasks: 0, memoryBytesSpilled: 0, executorRunTime: 1000 };
}

// Two stages with distinct names, so each pairs with its namesake in the other run.
function run(catalog, label) {
  const stages = new Map([[1, stage('Exchange orders')], [2, stage('Sort customers')]]);
  return { label, snapshot: { app: APP, stages, sql: new Map(), jobs: new Map(), catalog } };
}

const finding = (over) => ({ type: 'skew', rule: 'skew', stageId: 1, impactBand: 'critical', value: 10, ...over });

function budgetFor(comparison, band) {
  const appModel = { app: APP, stages: new Map(), executors: { added: [], removed: [] }, runAggregates: null };
  return evaluateBudgets({ appModel, catalog: [], budgets: { failOnIntroduced: band }, comparison })
    .results.find((r) => r.name === 'fail-on-introduced');
}

describe('findingKey', () => {
  const locator = { stage: (id) => `s${id}`, execution: (id) => `e${id}` };

  it('ignores the value and the impact band', () => {
    expect(findingKey(finding({ value: 1, impactBand: 'info' }), locator))
      .toBe(findingKey(finding({ value: 99, impactBand: 'critical' }), locator));
  });

  it('differs by type, rule and location', () => {
    const key = findingKey(finding(), locator);
    expect(findingKey(finding({ type: 'spill' }), locator)).not.toBe(key);
    expect(findingKey(finding({ rule: 'other' }), locator)).not.toBe(key);
    expect(findingKey(finding({ stageId: 2 }), locator)).not.toBe(key);
  });

  it('locates a stage-less finding by its execution, its config property, or the run', () => {
    expect(findingKey({ type: 'smallFiles', stageId: null, executionId: 3 }, locator)).toContain('execution:e3');
    expect(findingKey({ type: 'configAudit', stageId: null, property: 'spark.x' }, locator)).toContain('property:spark.x');
    expect(findingKey({ type: 'utilization', stageId: null }, locator)).toContain('run');
  });
});

describe('diffFindings', () => {
  const locator = { stage: (id) => `s${id}`, execution: (id) => `e${id}` };

  it('pairs findings that share a key one-to-one, same band first', () => {
    const base = [finding({ impactBand: 'warning' }), finding({ impactBand: 'critical' })];
    const cand = [finding({ impactBand: 'critical' }), finding({ impactBand: 'info' })];
    const diff = diffFindings(base, cand, locator, locator);
    expect(diff.introduced).toEqual([]);
    expect(diff.resolved).toEqual([]);
    expect(diff.changed.map((c) => [c.baseline.impactBand, c.candidate.impactBand])).toEqual([['warning', 'info']]);
  });

  it('reports the surplus of a shared key as introduced or resolved', () => {
    const one = [finding()], two = [finding(), finding()];
    expect(diffFindings(one, two, locator, locator).introduced).toHaveLength(1);
    expect(diffFindings(two, one, locator, locator).resolved).toHaveLength(1);
  });
});

describe('comparison across runs', () => {
  it('treats a finding re-banded critical to warning as changed, so the budget passes', () => {
    const comparison = compareRuns(run([finding({ impactBand: 'critical', value: 9 })], 'base'),
      run([finding({ impactBand: 'warning', value: 2 })], 'cand'));
    expect(comparison.findings.introduced).toEqual([]);
    expect(comparison.findings.resolved).toEqual([]);
    expect(comparison.findings.changed).toEqual([expect.objectContaining({
      rule: 'skew', baseImpactBand: 'critical', candImpactBand: 'warning', count: 1, stages: ['Exchange orders'],
    })]);
    expect(budgetFor(comparison, 'warning').status).toBe('pass');
    expect(budgetFor(comparison, 'all').status).toBe('pass');
    expect(comparisonVerdict(comparison).sentences.join(' ')).not.toMatch(/New or more frequent|Less frequent/);
  });

  it('reports a finding only the candidate has as introduced, so the budget fails', () => {
    const comparison = compareRuns(run([], 'base'), run([finding({ impactBand: 'warning' })], 'cand'));
    expect(comparison.findings.introduced).toEqual([expect.objectContaining({ rule: 'skew', impactBand: 'warning', candCount: 1 })]);
    expect(comparison.findings.changed).toEqual([]);
    expect(budgetFor(comparison, 'warning').status).toBe('violation');
    expect(comparisonVerdict(comparison).sentences.join(' ')).toMatch(/New or more frequent in the candidate: /);
  });

  it('reports a finding only the baseline has as resolved, so the budget passes', () => {
    const comparison = compareRuns(run([finding()], 'base'), run([], 'cand'));
    expect(comparison.findings.resolved).toEqual([expect.objectContaining({ rule: 'skew', impactBand: 'critical', baseCount: 1 })]);
    expect(comparison.findings.introduced).toEqual([]);
    expect(budgetFor(comparison, 'all').status).toBe('pass');
    expect(comparisonVerdict(comparison).sentences.join(' ')).toMatch(/Less frequent in the candidate: /);
  });

  it('reports a finding that moves to another stage as one resolved plus one introduced', () => {
    const comparison = compareRuns(run([finding({ stageId: 1 })], 'base'), run([finding({ stageId: 2 })], 'cand'));
    expect(comparison.findings.resolved).toEqual([expect.objectContaining({ baseCount: 1, stages: ['Exchange orders'] })]);
    expect(comparison.findings.introduced).toEqual([expect.objectContaining({ candCount: 1, stages: ['Sort customers'] })]);
    expect(comparison.findings.changed).toEqual([]);
    expect(budgetFor(comparison, 'critical').status).toBe('violation');
  });

  it('keeps a finding unchanged when the same stage carries a different stage id in each run', () => {
    const shifted = { label: 'cand', snapshot: { app: APP, jobs: new Map(), sql: new Map(),
      stages: new Map([[7, stage('Exchange orders')], [8, stage('Sort customers')]]),
      catalog: [finding({ stageId: 7, impactBand: 'critical', value: 3 })] } };
    const comparison = compareRuns(run([finding({ stageId: 1, impactBand: 'critical', value: 8 })], 'base'), shifted);
    expect(comparison.findings).toEqual({ introduced: [], resolved: [], changed: [] });
  });
});
