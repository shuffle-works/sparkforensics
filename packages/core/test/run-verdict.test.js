import { describe, it, expect } from 'vitest';
import {
  buildNextSteps, buildRunVerdict, FINDING_DISPLAY_ORDER, locationKey, rankBySavings, verdictIdlePct,
} from '../src/run-verdict.ts';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

function timed(type, stageId, highSeconds, extra = {}) {
  return {
    type, stageId, impactBand: 'warning', recommendation: `Fix ${type}.`,
    impactEstimate: { basis: 'serial', estimateMethod: 'measured', wallClock: { low: highSeconds * 1000, high: highSeconds * 1000 } },
    ...extra,
  };
}

/** A finding with a wall-clock estimate given in ms and a band (critical by default). */
function timedMs(type, stageId, highMs, impactBand = 'critical') {
  return {
    type, impactBand, stageId, recommendation: `Fix ${type} in Stage ${stageId}.`,
    impactEstimate: { basis: 'serial', wallClock: { low: highMs, high: highMs }, estimateMethod: 'modeled' },
  };
}

function appModel(overrides = {}) {
  return {
    app: makeApp(),
    stages: new Map([[1, makeStage({ id: 1 })], [2, makeStage({ id: 2 })]]),
    executors: { added: [], removed: [] },
    jobs: new Map(),
    sql: new Map(),
    runAggregates: null,
    ...overrides,
  };
}

describe('rankBySavings', () => {
  it('ranks quantified savings first, then band, then widget display order', () => {
    const unquantifiedInfoSkew = { type: 'skew', stageId: 4, impactBand: 'info', recommendation: 'r' };
    const unquantifiedInfoSpill = { type: 'spill', stageId: 5, impactBand: 'info', recommendation: 'r' };
    const ranked = rankBySavings([unquantifiedInfoSkew, unquantifiedInfoSpill, timed('gc', 1, 5), timed('skew', 2, 30)]);
    const byDisplayOrder = ['skew', 'spill'].sort((a, b) => FINDING_DISPLAY_ORDER.indexOf(a) - FINDING_DISPLAY_ORDER.indexOf(b));
    expect(ranked.map((f) => f.type)).toEqual(['skew', 'gc', ...byDisplayOrder]);
  });

  it('skips a finding with no recommendation', () => {
    expect(rankBySavings([{ type: 'skew', stageId: 1, impactBand: 'critical' }])).toEqual([]);
  });
});

describe('buildNextSteps', () => {
  it('groups a single-stage sql finding with the per-stage findings of that stage', () => {
    const smallFiles = { ...timed('smallFiles', null, 2), stageIds: [3] };
    expect(locationKey(smallFiles).key).toBe('stage:3');
    const steps = buildNextSteps([timed('skew', 3, 1), smallFiles]);
    expect(steps).toHaveLength(1);
    expect(steps[0].lead.type).toBe('smallFiles');
    expect(steps[0].related.map((f) => f.type)).toEqual(['skew']);
  });

  it('puts a failure at a failed job stage first on a failed run', () => {
    const stageFailed = { type: 'stageFailed', stageId: 2, impactBand: 'critical', value: 'boom', recommendation: 'Inspect.' };
    const steps = buildNextSteps([timed('skew', 1, 60), stageFailed], { failedJobStageIds: new Set([2]) });
    expect(steps.map((s) => s.lead.type)).toEqual(['stageFailed', 'skew']);
  });

  it('folds findings that share a stage into one step led by the biggest win, one related entry per type', () => {
    const skew = timedMs('skew', 7, 2_400);
    const straggler = timedMs('straggler', 7, 2_300);
    const secondStraggler = { ...timedMs('straggler', 7, 100), recommendation: 'Another straggler.' };
    const spill = timedMs('spill', 3, 1_000, 'warning');

    const steps = buildNextSteps([spill, straggler, secondStraggler, skew]);

    expect(steps.map((step) => step.key)).toEqual(['stage:7', 'stage:3']);
    expect(steps[0].lead).toBe(skew);
    expect(steps[0].related).toEqual([straggler]);
    expect(steps[0].stageId).toBe(7);
    expect(steps[1].related).toEqual([]);
  });

  it('keeps app-level findings of different types, and multi-stage plan findings, as separate places', () => {
    expect(locationKey({ type: 'utilization', impactBand: 'info', stageId: null }).key).toBe('app:utilization');
    expect(locationKey({ type: 'smallFiles', impactBand: 'info', stageIds: [4] })).toEqual({ key: 'stage:4', stageId: 4 });
    expect(locationKey({ type: 'duplicatePlanSubtree', impactBand: 'info', stageIds: [2, 0] }))
      .toEqual({ key: 'stages:duplicatePlanSubtree:0,2', stageId: null });
    expect(locationKey({ type: 'memoryUtilization', variant: 'idleCores', impactBand: 'warning', stageId: null }).key)
      .toBe('app:memoryUtilization:idleCores');
  });
});

describe('idle capacity in the next steps', () => {
  const idleCores = {
    type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'warning',
    recommendation: '92% of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.',
  };
  const steps = () => buildNextSteps([timedMs('skew', 0, 64), idleCores]);

  it('keeps the savings order however much capacity sat idle', () => {
    expect(steps().map((step) => step.lead.type)).toEqual(['skew', 'memoryUtilization']);
  });

  it('keeps a heap-pressure memoryUtilization finding and idleCores as separate steps', () => {
    const heapNearCapacity = {
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity', stageId: null, impactBand: 'warning',
      recommendation: 'Raise spark.executor.memory to avoid OOM.',
    };
    const both = buildNextSteps([timedMs('skew', 0, 64), heapNearCapacity, { ...idleCores, impactBand: 'info' }]);
    expect(both.map((step) => step.key)).toContain('app:memoryUtilization:idleCores');
    expect(both[0].lead.type).toBe('skew');
  });

  it('states the idle share the idle-capacity step itself reports, falling back to the Scorecard figure', () => {
    expect(verdictIdlePct(steps(), 80)).toBe(80);
    expect(verdictIdlePct(buildNextSteps([timedMs('skew', 0, 64), { ...idleCores, value: 55 }]), 80)).toBe(55);
    const utilization = { type: 'utilization', stageId: null, impactBand: 'info', value: 30, recommendation: 'x' };
    expect(verdictIdlePct(buildNextSteps([utilization]), 80)).toBe(70);
    expect(verdictIdlePct(buildNextSteps([timedMs('skew', 0, 64)]), 80)).toBe(80);
  });
});

describe('buildRunVerdict', () => {
  it('leads with the failed jobs and quotes the reason in the copied step', () => {
    const jobs = new Map([
      [0, { id: 0, result: 'JobSucceeded', succeeded: true, stageIds: [1] }],
      [1, { id: 1, result: 'JobFailed', succeeded: false, stageIds: [2] }],
    ]);
    const stageFailed = { type: 'stageFailed', stageId: 2, impactBand: 'critical', value: 'Task failed: boom\n\tat x', recommendation: 'Inspect the driver log.' };
    const verdict = buildRunVerdict(appModel({ jobs }), [timed('skew', 1, 60), stageFailed]);
    expect(verdict.title).toBe('1 of 2 jobs failed in this run');
    expect(verdict.summary[0]).toBe('Fix the failure before tuning: the other findings cover only the work that ran.');
    expect(verdict.shown[0].lead.type).toBe('stageFailed');
    expect(verdict.copyText).toContain("1. Inspect stage failure in Stage 2: Spark's recorded reason: Task failed: boom.");
    expect(verdict.copyText).toContain('2. ');
  });

  it('names the stage to start with and what the first fix could save', () => {
    const verdict = buildRunVerdict(appModel(), [timed('skew', 1, 2)]);
    expect(verdict.title).toBe('Start with Stage 1');
    expect(verdict.summary).toContain('1 finding in 1 place.');
    expect(verdict.summary.some((s) => /^The first fix could save up to 2\.0s of this/.test(s))).toBe(true);
    expect(verdict.remaining).toBe(0);
  });

  it('lists at most three steps and counts the rest', () => {
    const findings = [1, 2, 3, 4, 5].map((id) => timed('skew', id, id));
    const verdict = buildRunVerdict(appModel(), findings);
    expect(verdict.shown.map((s) => s.stageId)).toEqual([5, 4, 3]);
    expect(verdict.remaining).toBe(2);
    expect(verdict.copyText).toMatch(/2 more places to look at in the full findings list\.$/);
  });
});
