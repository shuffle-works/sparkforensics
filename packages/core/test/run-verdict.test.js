import { describe, it, expect } from 'vitest';
import {
  buildCostLane, buildNextSteps, buildRunIdleLine, buildRunVerdict, FINDING_DISPLAY_ORDER, locationKey, rankBySavings, verdictIdlePct,
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
    const stageFailed = { type: 'stageFailed', stageId: 2, impactBand: 'critical', valueText: 'boom', recommendation: 'Inspect.' };
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
    recommendation: '92% of available core-time ran no task: reduce cluster size or enable dynamic allocation.',
  };
  const steps = () => buildNextSteps([timedMs('skew', 0, 64), idleCores]);

  it('keeps the savings order however much capacity sat idle', () => {
    expect(steps().map((step) => step.lead.type)).toEqual(['skew', 'memoryUtilization']);
  });

  it('keeps a heap-sizing memoryUtilization finding and idleCores as separate steps', () => {
    const heapOverProvisioned = {
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned', stageId: null, impactBand: 'warning',
      recommendation: 'Executors peaked at 20% of allocated heap: reduce spark.executor.memory.',
    };
    const both = buildNextSteps([timedMs('skew', 0, 64), heapOverProvisioned, { ...idleCores, impactBand: 'info' }]);
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
    const stageFailed = { type: 'stageFailed', stageId: 2, impactBand: 'critical', valueText: 'Task failed: boom\n\tat x', recommendation: 'Inspect the driver log.' };
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

function cored(type, stageId, coreMs, extra = {}) {
  return {
    type, stageId, impactBand: 'info', recommendation: `Fix ${type}.`,
    impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: coreMs, unit: 'coreMs' }, coreTimeMs: { low: coreMs, high: coreMs } },
    ...extra,
  };
}

describe('buildCostLane', () => {
  it('ranks by measured busy core time, including findings with no wall-clock claim', () => {
    const lane = buildCostLane([cored('gc', 1, 3_600_000), cored('retryWaste', 2, 7_200_000), timed('skew', 3, 60)]);
    expect(lane.map((entry) => entry.finding.type)).toEqual(['retryWaste', 'gc']);
    expect(lane.map((entry) => entry.figure)).toEqual(['2.0 core-h', '1.0 core-h']);
  });

  it('leaves out idle capacity, bytes-only, null and zero core-time findings', () => {
    const idle = { ...cored('utilization', null, 5_000_000), impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 1.4, unit: 'coreHours', idle: true }, idleCoreTimeMs: { low: 5e6, high: 5e6 } } };
    const bytes = { ...cored('stageShape', 4, 0), impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 9e9, unit: 'bytes' } } };
    const nulled = { ...cored('straggler', 5, 1000), impactEstimate: { basis: 'serial', wallClock: { low: 1, high: 2 }, estimateMethod: 'measured', coreTimeMs: null } };
    expect(buildCostLane([idle, bytes, nulled, cored('gc', 6, 0)])).toEqual([]);
  });

  it('keeps the wall-clock steps in their own order', () => {
    const findings = [timed('skew', 1, 60), cored('gc', 2, 3_600_000)];
    const verdict = buildRunVerdict(appModel(), findings);
    expect(verdict.shown.map((step) => step.lead.type)).toEqual(['skew', 'gc']);
    expect(verdict.costLane.map((entry) => entry.finding.type)).toEqual(['gc']);
  });
});

describe('buildRunIdleLine', () => {
  const model = (busyCoreMs) => appModel({
    app: makeApp({ startTime: 0, endTime: 3_600_000 }),
    executors: { added: [{ executorId: '1', timestamp: 0, totalCores: 4 }], removed: [] },
    runAggregates: { busyCoreMs },
  });

  it('states the idle core time and its share of the allocation', () => {
    const line = buildRunIdleLine(model(3_600_000 * 3));
    expect(line).toMatchObject({ coreHours: 1, allocatedCoreHours: 4, pct: 25 });
    expect(line.text).toBe('1.0 core-h (25%) of the allocation ran no task.');
  });

  it('is null without an allocation or with none idle', () => {
    expect(buildRunIdleLine(appModel())).toBeNull();
    expect(buildRunIdleLine(model(3_600_000 * 4))).toBeNull();
  });
});
