import { describe, it, expect } from 'vitest';
import {
  buildNextSteps, buildRunVerdict, FINDING_DISPLAY_ORDER, locationKey, rankBySavings,
} from '../src/run-verdict.ts';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

function timed(type, stageId, highSeconds, extra = {}) {
  return {
    type, stageId, impactBand: 'warning', recommendation: `Fix ${type}.`,
    impactEstimate: { basis: 'serial', estimateMethod: 'measured', wallClock: { low: highSeconds * 1000, high: highSeconds * 1000 } },
    ...extra,
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
