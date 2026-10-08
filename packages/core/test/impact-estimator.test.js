import { describe, it, expect } from 'vitest';
import { estimateImpact } from '../src/impact-estimator.js';
import { computeOccupancy } from '../src/occupancy.js';

// estimateImpact reads analyze()'s one occupancy sweep: build it here the way analyze() does.
// coreTimeMs is covered by impact-core-time.test.js; dropped here so these assertions stay about
// the wall-clock and raw figures.
function estimate(findings, stages, totalCores = 0) {
  estimateImpact(findings, { stages, totalCores, occupancy: computeOccupancy(stages, totalCores) });
  for (const f of findings) if (f.impactEstimate) delete f.impactEstimate.coreTimeMs;
  return findings;
}

describe('estimateImpact: skeleton', () => {
  it('returns the same findings array reference, unmodified for an unrecognized type', () => {
    const findings = [{ type: 'not-a-real-detector', impactBand: 'info' }];
    const stages = new Map();
    const result = estimate(findings, stages);
    expect(result).toBe(findings);
    expect(result[0].impactEstimate).toBeUndefined();
  });
});

function stage(id, opts) {
  return { id, parentIds: [], submittedAt: 0, completedAt: 0, ...opts };
}

describe('estimateImpact: measured group A', () => {
  it('retryWaste: a solo stage (gate 1) gets a serial point estimate at its own retryWasteMs', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [], retryWasteMs: 1200 }]]);
    const findings = [{ type: 'retryWaste', stageId: 0, metric: 'retryWasteMs', value: 1200, impactBand: 'warning' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 1200, high: 1200 }, estimateMethod: 'measured',
      rawWaste: { value: 1200, unit: 'ms' },
    });
  });

  it('retryWaste: rawWaste keeps the pre-clip magnitude, and contention (not slack) now produces an honest range instead of a false zero', () => {
    // Stage 1 fully overlaps stage 0's much longer window; both have no
    // executorRunTime data, so the shared interval splits their occupancy
    // equally: stage 1's gate is 0.5 (occupies half its own 3000ms span).
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 50000, parentIds: [] }],
      [1, { id: 1, submittedAt: 0, completedAt: 3000, parentIds: [], retryWasteMs: 1200 }],
    ]);
    const findings = [{ type: 'retryWaste', stageId: 1, metric: 'retryWasteMs', value: 1200, impactBand: 'warning' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.basis).toBe('contended');
    expect(est.wallClock).toEqual({ low: 600, high: 1200 });
    expect(est.rawWaste).toEqual({ value: 1200, unit: 'ms' });
  });

  it('retryWaste: attempts of different tasks ran side by side, so the claim is one attempt, not their sum', () => {
    // 4 first attempts (one lost executor's tasks) of 36.5s mean, on a stage with 40 slots:
    // max(1 x 36.5s, 146s / 40) = 36.5s, modeled.
    const samples = [0, 0, 0, 0].map((attemptNumber) => ({ attemptNumber }));
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 1_000_000, parentIds: [],
      retryWasteMs: 146_000, wastedAttempts: 4, retryTaskSamples: samples, peakConcurrentTasks: 40,
    }]]);
    const findings = [{ type: 'retryWaste', stageId: 0, metric: 'retryWasteMs', value: 146_000, impactBand: 'warning' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 36_500, high: 36_500 }, estimateMethod: 'modeled',
      rawWaste: { value: 146_000, unit: 'ms' },
    });
  });

  it('retryWaste: one task failing again and again claims its whole chain, and unsampled attempts the sum', () => {
    const at = (retryTaskSamples, wastedAttempts) => {
      const stages = new Map([[0, {
        id: 0, submittedAt: 0, completedAt: 1_000_000, parentIds: [],
        retryWasteMs: 90_000, wastedAttempts, retryTaskSamples, peakConcurrentTasks: 40,
      }]]);
      const findings = [{ type: 'retryWaste', stageId: 0, metric: 'retryWasteMs', value: 90_000, impactBand: 'warning' }];
      estimate(findings, stages);
      return findings[0].impactEstimate;
    };
    // Attempts 0, 1, 2 of one task ran one after another: 3 x 30s.
    expect(at([0, 1, 2].map((attemptNumber) => ({ attemptNumber })), 3).wallClock.high).toBe(90_000);
    // 25 wasted attempts but only 20 sampled (the cap): the chain isn't known.
    const capped = at(Array.from({ length: 20 }, () => ({ attemptNumber: 0 })), 25);
    expect(capped.wallClock.high).toBe(90_000);
    expect(capped.estimateMethod).toBe('measured');
  });

  it('speculationWaste: clips the stage\'s own speculationWasteMs the same way', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [], speculationWasteMs: 800 }]]);
    const findings = [{ type: 'speculationWaste', stageId: 0, metric: 'speculationWasteMs', value: 800, impactBand: 'info' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 800, high: 800 }, estimateMethod: 'measured',
      rawWaste: { value: 800, unit: 'ms' },
    });
  });

  it('coldStart: reports a serial point estimate unconditionally (app-scoped, no stage lookup, can never overlap a stage)', () => {
    const findings = [{ type: 'coldStart', stageId: null, metric: 'startupGapSeconds', value: 12, impactBand: 'warning' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 12000, high: 12000 }, estimateMethod: 'measured',
    });
  });
});

describe('estimateImpact: gc', () => {
  it('converts the cross-task jvmGCTime sum to an approximate wall-clock figure by dividing by average concurrency', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 25000, parentIds: [],
      jvmGCTime: 100000, executorRunTime: 100000, // 4-way average concurrency (100000/25000)
    }]]);
    const findings = [{ type: 'gc', stageId: 0, impactBand: 'warning' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.estimateMethod).toBe('modeled');
    expect(est.basis).toBe('serial');
    expect(est.wallClock.high).toBeCloseTo(25000, 0);
    expect(est.rawWaste).toEqual({ value: 100000, unit: 'coreMs' });
  });

  it('reports the low-GC (over-provisioning) direction as informational: cutting memory raises GC, it recovers none', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 25000, parentIds: [], jvmGCTime: 2000, executorRunTime: 100000,
    }]]);
    const findings = [{ type: 'gc', stageId: 0, direction: 'low', impactBand: 'info' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });

  it('reports resourceOnly (not a wall-clock claim) when executorRunTime is zero (guards divide-by-zero)', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 1000, parentIds: [], jvmGCTime: 0, executorRunTime: 0 }]]);
    const findings = [{ type: 'gc', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 0, unit: 'coreMs' },
    });
  });
});

describe('estimateImpact: skew / straggler: the tail claim is floored at the longest task the fix leaves', () => {
  // These claims shorten the stage's longest task itself, so ceiling(S)'s taskDurationMax term
  // (the very task being fixed) can't be their floor: that used to cap a one-straggler stage's
  // claim at ~0. The floor is taskDurationMax - claim, or the core work the fix leaves over every
  // core.
  it('skew: P95 branch, floored at the longest task the fix leaves (9000 - 3000 = 6000 on a 10000ms stage)', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [],
      taskCount: 50, taskDurationP50: 1000, taskDurationP95: 4000, taskDurationMax: 9000,
    }]]);
    const findings = [{ type: 'skew', stageId: 0, metric: 'P95/median', impactBand: 'warning' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    // Raw claim P95-P50 = 3000; post-fix floor 6000 leaves 4000ms of room, so the claim fits whole.
    expect(est.wallClock).toEqual({ low: 3000, high: 3000 });
    expect(est.basis).toBe('serial');
    expect(est.rawWaste).toEqual({ value: 3000, unit: 'ms' });
  });

  it('skew: max-P50 fallback branch, a one-task-dominated stage recovers its whole tail', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [],
      taskCount: 5, taskDurationP50: 1000, taskDurationP95: 1500, taskDurationMax: 9000,
    }]]);
    const findings = [{ type: 'skew', stageId: 0, metric: 'max/median', impactBand: 'warning' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    // Raw claim max-P50 = 8000; post-fix floor is P50 (1000), room 9000: the old
    // taskDurationMax floor (9000) would have left only 1000.
    expect(est.wallClock).toEqual({ low: 8000, high: 8000 });
    expect(est.rawWaste).toEqual({ value: 8000, unit: 'ms' });
  });

  it('straggler: reconstructs max-P50, floored at P50 rather than at the straggler itself', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1000, taskDurationMax: 7000 }]]);
    const findings = [{ type: 'straggler', stageId: 0, metric: 'stragglerShare', impactBand: 'warning' }];
    estimate(findings, stages);
    // Raw claim max-P50 = 6000, room above the P50 floor is 9000: min(6000, 9000) = 6000.
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 6000, high: 6000 });
  });

  it('straggler: claims the straggler down to the longest task the fix leaves, not to P50', () => {
    // Tasks over 4x P50 (4000) come down to the median; the 3500ms one under it stays. The claim is
    // 7000 - 3500, not 7000 - 1000.
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1000, taskDurationMax: 7000,
      stragglerCount: 1, stragglerExcessMs: 6000, peakConcurrentTasks: 4, longestNonStragglerMs: 3500,
    }]]);
    const findings = [{ type: 'straggler', stageId: 0, metric: 'stragglerShare', impactBand: 'warning' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 3500, high: 3500 });
  });

  it('skew: floored at the longest task the fix leaves, the same as straggler on that stage', () => {
    // A 100s stage whose one 100s task is over 4x P50 (40s) and whose next-longest is 39s: fixing
    // the skew still waits on that 39s task, so skew can't claim more than straggler's 61s.
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 100_000, parentIds: [], taskCount: 20,
      taskDurationP50: 10_000, taskDurationP95: 39_000, taskDurationMax: 100_000,
      stragglerCount: 1, stragglerExcessMs: 90_000, peakConcurrentTasks: 4, longestNonStragglerMs: 39_000,
    }]]);
    const findings = [
      { type: 'skew', stageId: 0, metric: 'max/median', impactBand: 'warning' },
      { type: 'straggler', stageId: 0, metric: 'stragglerShare', impactBand: 'warning' },
    ];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 61_000, high: 61_000 });
    expect(findings[1].impactEstimate.wallClock).toEqual({ low: 61_000, high: 61_000 });
  });

  it('straggler: the stage\'s core work spread over every core still caps the claim', () => {
    // 44000 core-ms less the 8000 the fix removes = 36000 over 4 cores, 9000ms of unavoidable work
    // on a 10000ms stage: room 1000.
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1000, taskDurationMax: 9000, executorRunTime: 44000,
    }]]);
    const findings = [{ type: 'straggler', stageId: 0, metric: 'stragglerShare', impactBand: 'warning' }];
    estimate(findings, stages, 4);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 1000, high: 1000 });
    expect(findings[0].impactEstimate.rawWaste).toEqual({ value: 8000, unit: 'ms' });
  });

  // A bimodal stage (hundreds of tasks over 4x P50) recovers its tasks' summed excess spread over
  // the slots it had, far more than the single longest task's excess.
  it('skew and straggler: a tail of many slow tasks claims its summed excess over the stage\'s peak slots', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 1_000_000, parentIds: [], taskCount: 1400,
      taskDurationP50: 6000, taskDurationP95: 30_000, taskDurationMax: 80_000,
      stragglerExcessMs: 14_500_000, peakConcurrentTasks: 29,
    }]]);
    const findings = [
      { type: 'straggler', stageId: 0, metric: 'stragglerShare', impactBand: 'warning' },
      { type: 'skew', stageId: 0, metric: 'P95/median', impactBand: 'warning' },
    ];
    estimate(findings, stages);
    // 14_500_000 / 29 = 500_000, over max-P50 (74_000) and P95-P50 (24_000).
    expect(findings[0].impactEstimate.rawWaste).toEqual({ value: 500_000, unit: 'ms' });
    expect(findings[1].impactEstimate.rawWaste).toEqual({ value: 500_000, unit: 'ms' });
  });

  it('stageShape with an unrecognized rule: leaves impactEstimate unset (null, not undefined, internally)', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 500, taskDurationMax: 8000 }]]);
    const findings = [{ type: 'stageShape', rule: 'someOtherRule', stageId: 0, impactBand: 'warning' }];
    const result = estimate(findings, stages);
    expect(result[0].impactEstimate).toBeUndefined();
  });
});

describe('estimateImpact: slowHost duration-based variants (no taskDurationMax set, so ceiling is 0 and the clip is a no-op)', () => {
  it('hostMeanRatio branch: excess duration of the slow host over the stage median', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 2000 }]]);
    const findings = [{ type: 'slowHost', stageId: 0, metric: 'hostMeanRatio', value: 3, hostMeanMs: 6000, impactBand: 'warning' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 4000, high: 4000 });
  });

  it('durationShare variant: same reconstruction, from hostMeanMs rather than the 0-1 share in `value`', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1000 }]]);
    const findings = [{
      type: 'slowHost', stageId: 0, variant: 'durationShare',
      metric: 'hostDurationShare', value: 0.82, hostMeanMs: 5000, impactBand: 'warning',
    }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 4000, high: 4000 });
  });

  it('multiDim variant, taskTime dimension: execMaxValue is a genuine per-executor average duration', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1500 }]]);
    const findings = [{
      type: 'slowHost', stageId: 0, variant: 'multiDim', dimension: 'taskTime',
      metric: 'execMaxMedianRatio', value: 3.7, execMaxValue: 5500, impactBand: 'warning',
    }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 4000, high: 4000 });
  });

  it('multiDim variant, byte-based dimensions: informational, no absolute ms figure', () => {
    const findings = [{
      type: 'slowHost', stageId: 0, variant: 'multiDim', dimension: 'inputBytes',
      metric: 'execMaxMedianRatio', value: 3.2, execMaxValue: 900_000_000, impactBand: 'info',
    }];
    estimate(findings, new Map([[0, { id: 0, submittedAt: 0, completedAt: 1000, parentIds: [] }]]));
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });
});

describe('estimateImpact: duplicatePlanSubtree', () => {
  it('re-simulates across all redundant stages instead of summing their durations (fully serial, non-overlapping chain)', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 2000, parentIds: [] }],
      [1, { id: 1, submittedAt: 2000, completedAt: 5000, parentIds: [0] }], // 3000ms
      [2, { id: 2, submittedAt: 5000, completedAt: 9000, parentIds: [1] }], // 4000ms
    ]);
    const findings = [{
      type: 'duplicatePlanSubtree', stageIds: [1, 2],
      metric: 'subtreeOccurrences', value: 2, impactBand: 'warning',
    }];
    estimate(findings, stages);
    // 1/2 of each stage's duration is redundant: 1500 + 2000 = 3500; both
    // stages are solo (no overlap anywhere in the run) so basis is serial.
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 3500, high: 3500 }, estimateMethod: 'measured',
      rawWaste: { value: 3500, unit: 'ms' },
    });
  });

  it('caps the joint claim at the union of the finding\'s own stages when they overlap in wall-clock time', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 1000, parentIds: [] }], // Start
      [1, { id: 1, parentIds: [0], submittedAt: 1000, completedAt: 3000 }], // A, dur 2000
      [2, { id: 2, parentIds: [1], submittedAt: 3000, completedAt: 12000 }], // B1, dur 9000
      [3, { id: 3, parentIds: [1], submittedAt: 3000, completedAt: 5000 }], // B2, dur 2000, overlaps B1 3000-5000
      [4, { id: 4, parentIds: [2, 3], submittedAt: 12000, completedAt: 13000 }], // C, dur 1000
    ]);
    // 10 occurrences => 9/10 of each contributing stage's time is redundant.
    const findings = [{
      type: 'duplicatePlanSubtree', stageIds: [2, 3],
      metric: 'subtreeOccurrences', value: 10, impactBand: 'warning',
    }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    // Per-stage: B1 gate = 8000/9000 (occupies [3000,5000] jointly with B2,
    // then alone [5000,12000]); waste 8100 -> {low: 7200, high: 8100}.
    // B2 gate = 1000/2000 (occupies half its own span); waste 1800 ->
    // {low: 900, high: 1800}. Naive sum: high 9900, low 8100. The union of
    // [3000,12000] and [3000,5000] is [3000,12000] = 9000ms, which caps the
    // naive high-sum down to 9000.
    expect(est.wallClock.high).toBe(9000);
    expect(est.wallClock.high).toBeLessThan(8100 + 1800); // proves the union cap, not naive summing
    expect(est.wallClock.low).toBe(8100);
    expect(est.basis).toBe('contended');
  });

  it('claims only the redundant fraction of each stage, not the stage\'s full duration', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 100_000, parentIds: [] }],
      [1, { id: 1, submittedAt: 100_000, completedAt: 200_000, parentIds: [0] }],
    ]);
    const findings = [{
      type: 'duplicatePlanSubtree', stageIds: [0, 1],
      metric: 'subtreeOccurrences', value: 4, impactBand: 'warning',
    }];
    estimate(findings, stages);
    // 3/4 of 200_000ms total span is waste; both stages solo and non-overlapping.
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 150_000, high: 150_000 });
  });

  it('the minimum 2 occurrences claims exactly half, and a malformed occurrence count claims nothing quantifiable', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 100_000, parentIds: [] }],
      [1, { id: 1, submittedAt: 100_000, completedAt: 200_000, parentIds: [0] }],
    ]);
    const twice = [{
      type: 'duplicatePlanSubtree', stageIds: [0, 1],
      metric: 'subtreeOccurrences', value: 2, impactBand: 'warning',
    }];
    estimate(twice, stages);
    expect(twice[0].impactEstimate.wallClock).toEqual({ low: 100_000, high: 100_000 });

    const malformed = [{ type: 'duplicatePlanSubtree', stageIds: [0, 1], impactBand: 'warning' }];
    estimate(malformed, stages);
    expect(malformed[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });

  it('duplicatePlanSubtree stage-set narrowing: a finding built with an already-narrowed stageIds only claims waste for that stage', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 10_000, parentIds: [] }], // the stage that ran the duplicated subtree
      [1, { id: 1, submittedAt: 10_000, completedAt: 20_000, parentIds: [0] }], // unrelated
      [2, { id: 2, submittedAt: 20_000, completedAt: 30_000, parentIds: [1] }], // unrelated
    ]);
    const findings = [{
      type: 'duplicatePlanSubtree', stageIds: [0], // already narrowed
      metric: 'subtreeOccurrences', value: 2, impactBand: 'warning',
    }];

    estimate(findings, stages);

    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 5_000, high: 5_000 });
  });

  // stageShares (the repeated operators' share of each stage) and task-active time replace whole
  // submit-to-complete durations: a stage shared with other work, or one left waiting for cores,
  // isn't the subtree's time.
  it('weights each stage by its operator share and counts only task-active time', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 10_000, parentIds: [], taskActiveMs: 10_000 }],
      [1, { id: 1, submittedAt: 10_000, completedAt: 40_000, parentIds: [0], taskActiveMs: 6_000 }], // mostly waiting
      [2, { id: 2, submittedAt: 40_000, completedAt: 50_000, parentIds: [1], taskActiveMs: 10_000 }], // no share
    ]);
    const findings = [{
      type: 'duplicatePlanSubtree', stageIds: [0, 1, 2], stageShares: { 0: 0.5, 1: 1 }, occurrencesIdentical: true,
      metric: 'subtreeOccurrences', value: 2, impactBand: 'warning',
    }];
    estimate(findings, stages);
    // 1/2 redundant x (10_000 x 0.5 + 6_000 x 1) = 2_500 + 3_000.
    expect(findings[0].impactEstimate.rawWaste).toEqual({ value: 5_500, unit: 'ms' });
    expect(findings[0].impactEstimate.wallClock.high).toBe(5_500);
  });

  it('claims nothing for repeats with differing details or with no attributable stage', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10_000, parentIds: [] }]]);
    const differing = [{ type: 'duplicatePlanSubtree', stageIds: [0], stageShares: { 0: 1 }, occurrencesIdentical: false, value: 2, impactBand: 'info' }];
    const unattributed = [{ type: 'duplicatePlanSubtree', stageIds: [0], stageShares: {}, occurrencesIdentical: true, value: 2, impactBand: 'info' }];
    estimate(differing, stages);
    estimate(unattributed, stages);
    expect(differing[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
    expect(unattributed[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });
});

describe('estimateImpact: shuffle, spill (no taskDurationMax set, ceiling 0, solo stage: numbers unaffected by the redesign)', () => {
  it('shuffle: bytes / assumed throughput (parser fallback tier)', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], shuffleReadBytes: 1_250_000_000 }]]);
    const findings = [{ type: 'shuffle', stageId: 0, impactBand: 'warning' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.estimateMethod).toBe('modeled');
    expect(est.basis).toBe('serial');
    expect(est.wallClock.high).toBeGreaterThan(0);
    expect(est.rawWaste).toEqual({ value: 1_250_000_000, unit: 'bytes' });
  });

  it('shuffle: the link model is capped at the fetch wait the tasks measured, in wall-clock', () => {
    // 5 GB over one 125 MB/s link models 40s; the tasks blocked 80,000 core-ms on fetches at an
    // average concurrency of 8 (800,000 core-ms over 100s): 10s measured, which the claim can't exceed.
    const at = (fetchWaitTime) => {
      const stages = new Map([[0, {
        id: 0, submittedAt: 0, completedAt: 100000, parentIds: [],
        shuffleReadBytes: 5_000_000_000, executorRunTime: 800_000, fetchWaitTime,
      }]]);
      const findings = [{ type: 'shuffle', stageId: 0, impactBand: 'warning' }];
      estimate(findings, stages);
      return findings[0].impactEstimate;
    };
    expect(at(80_000).wallClock.high).toBeCloseTo(10_000, 6);
    expect(at(80_000).estimateMethod).toBe('measured');
    expect(at(0).wallClock.high).toBe(0);
    // More fetch wait than the model: the model stays the ceiling.
    expect(at(800_000).wallClock.high).toBeCloseTo(40_000, 6);
    expect(at(800_000).estimateMethod).toBe('modeled');
    expect(at(80_000).rawWaste).toEqual({ value: 5_000_000_000, unit: 'bytes' });
  });

  it('spill: uses diskBytesSpilled, not memoryBytesSpilled', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 100000, parentIds: [],
      diskBytesSpilled: 200_000_000, memoryBytesSpilled: 900_000_000,
    }]]);
    const findings = [{ type: 'spill', stageId: 0, impactBand: 'warning' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.estimateMethod).toBe('modeled');
    expect(est.wallClock.high).toBeGreaterThan(0);
    expect(est.wallClock.high).toBeLessThan(900_000_000 / 1000);
    expect(est.rawWaste).toEqual({ value: 200_000_000, unit: 'bytes' });
  });

  it('shuffle and spill: the byte volume is spread over every executor that ran the stage, one link/disk each', () => {
    const executorStats = [{ executorId: '1' }, { executorId: '2' }, { executorId: '3' }, { executorId: '4' }];
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], executorStats,
      shuffleReadBytes: 5_000_000_000, diskBytesSpilled: 8_000_000_000,
    }]]);
    const findings = [{ type: 'shuffle', stageId: 0, impactBand: 'warning' }, { type: 'spill', stageId: 0, impactBand: 'warning' }];
    estimate(findings, stages);
    // 5 GB over 4 x 125 MB/s = 10s (one shared link would claim 40s); 8 GB over 4 x 200 MB/s = 10s.
    expect(findings[0].impactEstimate.wallClock.high).toBeCloseTo(10000, 6);
    expect(findings[1].impactEstimate.wallClock.high).toBeCloseTo(10000, 6);
    expect(findings[0].impactEstimate.rawWaste).toEqual({ value: 5_000_000_000, unit: 'bytes' });
  });
});

describe('estimateImpact: stageSlowness', () => {
  const min = 60 * 1000;

  it('an under-partitioned stage: its task-active time spread over every core the cluster had', () => {
    // 2 tasks on a 16-core cluster, running for 20 of the stage's 22 minutes: more partitions
    // could spread those 20 minutes over all 16 cores, recovering 20 x (1 - 2/16) = 17.5 minutes.
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 22 * min, parentIds: [], taskCount: 2, taskActiveMs: 20 * min, taskDurationMax: 20 * min, shuffleReadBytes: 1e9,
    }]]);
    const findings = [{ type: 'stageSlowness', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages, 16);
    const est = findings[0].impactEstimate;
    expect(est.estimateMethod).toBe('modeled');
    expect(est.wallClock.high).toBeCloseTo(17.5 * min, 6);
  });

  it('a stage that already ran more tasks than cores gets nothing from more partitions', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 40 * min, parentIds: [], taskCount: 500, taskActiveMs: 40 * min, shuffleReadBytes: 1e9,
    }]]);
    const findings = [{ type: 'stageSlowness', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages, 16);
    expect(findings[0].impactEstimate.wallClock.high).toBe(0);
  });

  it('time the stage sat open with no task running is queueing, not recoverable by partitioning', () => {
    // Open 30 minutes, but its only task ran 2 seconds.
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 30 * min, parentIds: [], taskCount: 1, taskActiveMs: 2000, taskDurationMax: 2000, inputBytes: 1e6,
    }]]);
    const findings = [{ type: 'stageSlowness', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages, 16);
    expect(findings[0].impactEstimate.wallClock.high).toBeCloseTo(2000 * (15 / 16), 6);
  });

  // A 1-task stage that read no bytes, its only task running 27 minutes; cpuMs sets the task's
  // executorCpuTime (Spark reports nanoseconds).
  const oneTaskStage = (cpuMs, extra = {}) => new Map([[0, {
    id: 0, submittedAt: 0, completedAt: 27 * min, parentIds: [], taskCount: 1, taskActiveMs: 27 * min, taskDurationMax: 27 * min,
    executorRunTime: 27 * min, executorCpuTime: cpuMs * 1e6, inputBytes: 0, shuffleReadBytes: 0, ...extra,
  }]]);
  const claimFor = (stages) => {
    const findings = [{ type: 'stageSlowness', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages, 16);
    return findings[0].impactEstimate.wallClock.high;
  };

  it('tasks idle on an external system (a JDBC read on 5s of CPU in 27 minutes) claim nothing', () => {
    expect(claimFor(oneTaskStage(5000))).toBe(0);
  });

  it('a stage that read no bytes but kept its task on CPU (generated data) is still claimed', () => {
    expect(claimFor(oneTaskStage(25 * min))).toBeCloseTo(27 * min * (15 / 16), 6);
  });

  it('the idle cut-off is a CPU share of 1%: at 1% the stage is claimed, just under it is not', () => {
    expect(claimFor(oneTaskStage(0.01 * 27 * min))).toBeCloseTo(27 * min * (15 / 16), 6);
    expect(claimFor(oneTaskStage(0.0099 * 27 * min))).toBe(0);
  });

  it('a stage that read input keeps its claim whatever its CPU share', () => {
    expect(claimFor(oneTaskStage(1000, { inputBytes: 1e9 }))).toBeCloseTo(27 * min * (15 / 16), 6);
    expect(claimFor(oneTaskStage(1000, { shuffleReadBytes: 1e9 }))).toBeCloseTo(27 * min * (15 / 16), 6);
  });

  it('a CPU share it cannot trust leaves the claim: no CPU metric, or Python work behind PythonRDD', () => {
    expect(claimFor(oneTaskStage(0))).toBeCloseTo(27 * min * (15 / 16), 6);
    expect(claimFor(oneTaskStage(1000, {
      name: 'runJob at PythonRDD.scala:181', details: 'org.apache.spark.api.python.PythonRDD$.runJob(PythonRDD.scala:181)',
    }))).toBeCloseTo(27 * min * (15 / 16), 6);
  });

  it('without a cluster core count there is no headroom figure: informational', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 20 * min, parentIds: [], taskCount: 2 }]]);
    const findings = [{ type: 'stageSlowness', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });
});

describe('estimateImpact: partitionSizing, tinyTask', () => {
  it('maxPartitionTooBig rule: shuffleReadMax / throughput', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], shuffleReadMax: 500_000_000 }]]);
    const findings = [{ type: 'partitionSizing', rule: 'maxPartitionTooBig', stageId: 0, impactBand: 'warning' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.wallClock.high).toBeGreaterThan(0);
  });

  it('shufflePartitionSkew rule: (max - p50) / throughput', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], shuffleReadMax: 500_000_000, shuffleReadP50: 100_000_000 }]]);
    const findings = [{ type: 'partitionSizing', rule: 'shufflePartitionSkew', stageId: 0, impactBand: 'warning' }];
    estimate(findings, stages);
    const expectedMs = ((500_000_000 - 100_000_000) / 125_000_000) * 1000;
    expect(findings[0].impactEstimate.wallClock.high).toBeCloseTo(expectedMs, 0);
  });

  it('lowShuffleParallelism rule: derives its own target task count', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 100000, parentIds: [],
      shuffleReadBytes: 2_000_000_000, taskCount: 4,
    }]]);
    const findings = [{ type: 'partitionSizing', rule: 'lowShuffleParallelism', stageId: 0, impactBand: 'warning' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.wallClock.high).toBeGreaterThanOrEqual(0);
  });

  describe('lowShuffleParallelism: the claim shortens the stage\'s longest task', () => {
    // 4 tasks read 1.5 GiB (target 12 tasks) over a 60 s stage: the serial waste is 40 s.
    const GiB = 1024 ** 3;
    function lowParStage(taskDurationMax) {
      return new Map([[0, {
        id: 0, submittedAt: 0, completedAt: 60_000, parentIds: [], taskCount: 4, shuffleReadBytes: 1.5 * GiB,
        taskDurationMax, executorRunTime: 4 * taskDurationMax,
      }]]);
    }
    const lowPar = () => [{ type: 'partitionSizing', rule: 'lowShuffleParallelism', stageId: 0, impactBand: 'warning' }];

    it('keeps the claim when the longest task nearly fills the stage', () => {
      // Clipped against the longest task itself the room is 30 ms. The split leaves that task at
      // 4/12 of 59.97 s, so the claim is the 39.98 s it sheds.
      const findings = lowPar();
      estimate(findings, lowParStage(59_970), 100);
      const { rawWaste, wallClock, estimateMethod } = findings[0].impactEstimate;
      expect(rawWaste.unit).toBe('ms');
      expect(rawWaste.value).toBeCloseTo(59_970 * (1 - 4 / 12), 6);
      expect(wallClock.high).toBeCloseTo(59_970 * (1 - 4 / 12), 6);
      expect(estimateMethod).toBe('modeled');
    });

    it('claims only what splitting the longest task recovers, however long the stage is', () => {
      // A 60 s stage whose longest task is 20 s: after the split the stage still takes 40 s plus the
      // 6.7 s the longest task leaves, a saving of 13.3 s, not the 40 s that scaling the whole
      // stage by 4/12 would claim.
      const findings = lowPar();
      estimate(findings, lowParStage(20_000), 100);
      const { rawWaste, wallClock } = findings[0].impactEstimate;
      expect(rawWaste.value).toBeCloseTo(20_000 * (1 - 4 / 12), 6);
      expect(wallClock.high).toBeCloseTo(20_000 * (1 - 4 / 12), 6);
      expect(60_000 - wallClock.high).toBeCloseTo(40_000 + 20_000 * 4 / 12, 6);
    });

    it('is still floored at the stage\'s core work spread over its cores', () => {
      // 4 x 59.97 s of task time over 8 cores cannot finish in under 29.985 s, split or not.
      const findings = lowPar();
      estimate(findings, lowParStage(59_970), 8);
      expect(findings[0].impactEstimate.wallClock.high).toBeCloseTo(60_000 - 4 * 59_970 / 8, 6);
    });

    it('stays capped by the stage window', () => {
      // A 1.5 s window cannot give back more than the window minus the longest task the split leaves.
      const stages = new Map([[0, {
        id: 0, submittedAt: 0, completedAt: 1_500, parentIds: [], taskCount: 4, shuffleReadBytes: 1.5 * GiB,
        taskDurationMax: 1_490, executorRunTime: 4 * 1_490,
      }]]);
      const findings = lowPar();
      estimate(findings, stages, 8);
      const { wallClock, rawWaste } = findings[0].impactEstimate;
      expect(wallClock.high).toBeLessThanOrEqual(rawWaste.value);
      expect(wallClock.high).toBeLessThanOrEqual(1_500 - 1_490 * 4 / 12);
    });
  });

  it('tinyTask: excess task count beyond a coalesce-to-1/10th target, at the assumed overhead when unmeasured', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], taskCount: 1000 }]]);
    const findings = [{ type: 'tinyTask', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.estimateMethod).toBe('modeled');
    expect(est.wallClock.high).toBe(900 * 50); // (1000 - round(1000/10)) excess tasks * 50ms
    expect(est.rawWaste).toEqual({ value: 900 * 50, unit: 'ms' });
  });

  it('tinyTask: uses the stage\'s own measured per-task overhead, spread over its achieved concurrency', () => {
    // 1000 tasks, 80,000ms of task time of which 60,000ms ran compute: 20ms overhead per task.
    // 80,000ms of task time in a 10,000ms stage is 8-way concurrency: 900 excess x 20ms / 8 = 2,250ms.
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskCount: 1000, executorRunTime: 60000,
      executorStats: [{ executorId: '1', totalDuration: 40000 }, { executorId: '2', totalDuration: 40000 }],
    }]]);
    const findings = [{ type: 'tinyTask', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.estimateMethod).toBe('measured');
    expect(est.wallClock.high).toBeCloseTo(2250, 6);
  });

  it('tinyTask: a mostly-idle stage never claims more wall-clock than the overhead it removes', () => {
    // 400 tasks, 8,000ms of task time in a 600,000ms stage (concurrency 0.013): 900 would claim
    // hours if divided by that concurrency; floored at 1 it is 360 excess x 5ms = 1,800ms.
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 600000, parentIds: [], taskCount: 400, executorRunTime: 6000,
      executorStats: [{ executorId: '1', totalDuration: 8000 }],
    }]]);
    const findings = [{ type: 'tinyTask', stageId: 0, impactBand: 'info' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.wallClock.high).toBeCloseTo(1800, 6);
  });
});

describe('estimateImpact: Plan Advisor trio', () => {
  it('smallFiles: apportioned evenly across two non-overlapping stages, stage-mappable', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [] }],
      [1, { id: 1, submittedAt: 5000, completedAt: 9000, parentIds: [0] }],
    ]);
    const findings = [{ type: 'smallFiles', stageIds: [0, 1], metric: 'avgFileSizeBytes', value: 1024, fileCount: 500, impactBand: 'warning' }];
    estimate(findings, stages);
    // 500 * 10ms = 5000ms total, 2500 per stage, both solo and non-overlapping.
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'modeled',
      rawWaste: { value: 5000, unit: 'ms' },
    });
  });

  // Reading tasks open their files in parallel; a write's job commit moves them one by one.
  it('smallFiles: a read spreads its per-file cost over the stage\'s peak concurrent tasks, a write stays serial', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100_000, parentIds: [], peakConcurrentTasks: 50 }]]);
    const read = [{ type: 'smallFiles', direction: 'read', stageIds: [0], metric: 'avgFileSizeBytes', value: 1024, fileCount: 5000, impactBand: 'warning' }];
    const write = [{ type: 'smallFiles', direction: 'write', stageIds: [0], metric: 'avgFileSizeBytes', value: 1024, fileCount: 5000, impactBand: 'warning' }];
    estimate(read, stages);
    estimate(write, stages);
    // 5000 files x 10ms = 50_000ms of opens; over 50 slots, 1_000ms.
    expect(read[0].impactEstimate.rawWaste).toEqual({ value: 1_000, unit: 'ms' });
    expect(write[0].impactEstimate.rawWaste).toEqual({ value: 50_000, unit: 'ms' });
  });

  it('smallFiles: resourceOnly when not stage-mappable, still reports the magnitude as rawWaste', () => {
    const findings = [{ type: 'smallFiles', stageIds: [], metric: 'avgFileSizeBytes', value: 1024, fileCount: 500, impactBand: 'warning' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 500 * 10, unit: 'ms' },
    });
  });

  it('overBroadcast/underBroadcast: resourceOnly when not stage-mappable, magnitude kept as rawWaste', () => {
    const over = [{ type: 'overBroadcast', metric: 'broadcastBytes', value: 250_000_000, impactBand: 'warning' }];
    estimate(over, new Map());
    expect(over[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 2000, unit: 'ms' },
    });

    const under = [{ type: 'underBroadcast', stageIds: [], metric: 'smallerSideBytes', value: 125_000_000, impactBand: 'warning' }];
    estimate(under, new Map());
    expect(under[0].impactEstimate.rawWaste).toEqual({ value: 1000, unit: 'ms' });
  });

  it('a zero-magnitude, non-stage-mappable finding is informational, no rawWaste', () => {
    const findings = [{ type: 'smallFiles', stageIds: [], metric: 'avgFileSizeBytes', value: 1024, fileCount: 0, impactBand: 'info' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('overBroadcast: stage-mappable: the ceiling now caps the claim at the stage\'s own duration, fixing the historical overclaim bug', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [] }]]);
    const findings = [{ type: 'overBroadcast', stageIds: [0], metric: 'broadcastBytes', value: 700_000_000, impactBand: 'warning' }];
    estimate(findings, stages);
    // Raw claim: 700_000_000 / 125_000_000 * 1000 = 5600ms, more than the
    // stage's own 5000ms duration. Capped at duration - ceiling(0) = 5000.
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'modeled',
      rawWaste: { value: 5600, unit: 'ms' },
    });
  });

  it('underBroadcast: stage-mappable, same duration cap applies', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [] }]]);
    const findings = [{
      type: 'underBroadcast', stageIds: [0],
      metric: 'smallerSideBytes', value: 700_000_000, largerSideBytes: 900_000_000, impactBand: 'warning',
    }];
    estimate(findings, stages);
    // Raw claim: 700_000_000 / 125_000_000 * 1000 = 5600ms, capped at the stage's own 5000ms.
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'modeled',
      rawWaste: { value: 5600, unit: 'ms' },
    });
  });

  it('a multi-stage waste is apportioned across its stages, not claimed in full once per stage', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 100_000, parentIds: [] }],
      [1, { id: 1, submittedAt: 100_000, completedAt: 200_000, parentIds: [0] }],
    ]);
    const findings = [{ type: 'smallFiles', stageIds: [0, 1], metric: 'avgFileSizeBytes', value: 1024, fileCount: 4000, impactBand: 'warning' }];
    estimate(findings, stages);
    // 4000 * 10ms = 40_000ms total, both stages solo and non-overlapping.
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 40_000, high: 40_000 });
  });
});

describe('estimateImpact: cost-only group A', () => {
  it('memoryUtilization wasteModel variant: resourceOnly, passes through the existing wastedMBSeconds as rawWaste', () => {
    const findings = [{ type: 'memoryUtilization', variant: 'wasteModel', metric: 'wastedMBSeconds', value: 12345, impactBand: 'warning' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured',
      rawWaste: { value: 12345, unit: 'mbSeconds' },
    });
  });

  it('memoryUtilization: an unrecognized variant is informational, no rawWaste', () => {
    const findings = [{ type: 'memoryUtilization', variant: 'bandTooSmall', impactBand: 'info' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('memoryUtilization idleCores: resourceOnly, idle rate * allocated memory-seconds, in MB-seconds', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'idleCores', metric: 'idleCoreRate', value: 75, impactBand: 'warning',
      idleRateFraction: 0.75, allocatedMBSeconds: 9_830_400,
    }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 7_372_800, unit: 'mbSeconds' },
    });
  });

  it('memoryUtilization idleCores: informational when the allocated memory-time is missing', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'idleCores', metric: 'idleCoreRate', value: 75, impactBand: 'warning',
      idleRateFraction: 0.75, allocatedMBSeconds: null,
    }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('memoryUtilization memoryBand heapOverProvisioned: resourceOnly, unused heap held by every executor while alive, in MB-seconds', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned',
      executorId: '3', metric: 'heapUsedRatio', value: 25, impactBand: 'info',
      allocatedBytes: 1000 * 1024 * 1024, heap: 250 * 1024 * 1024, executorCount: 2, executorSeconds: 240,
    }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 180_000, unit: 'mbSeconds' },
    });
  });

  it('memoryUtilization memoryBand dataUnavailable: no rule, no inputs, informational', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'memoryBand', metric: 'memoryBand',
      dataUnavailable: true, impactBand: 'info',
    }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('utilization: resourceOnly, idle core-hours from the real utilizationFraction, no assumed constant', () => {
    const findings = [{
      type: 'utilization', utilizationFraction: 0.4, impactBand: 'warning',
      appDurationMs: 3_600_000, totalCores: 10, allocatedCoreMs: 10 * 3_600_000,
    }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured',
      rawWaste: { value: 6, unit: 'coreHours', idle: true },
      idleCoreTimeMs: { low: 6 * 3_600_000, high: 6 * 3_600_000 },
    });
  });

  it('utilization: a missing allocatedCoreMs falls back to informational', () => {
    const findings = [{ type: 'utilization', utilizationFraction: 0.4, impactBand: 'warning' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'measured' });
  });

  it('coreLocality: resourceOnly, modeled network-fetch penalty as extra core-time, not wall-clock', () => {
    const findings = [{ type: 'coreLocality', nonLocalTaskCount: 40, impactBand: 'info' }];
    estimate(findings, new Map());
    const est = findings[0].impactEstimate;
    expect(est.basis).toBe('resourceOnly');
    expect(est.wallClock).toBeNull();
    expect(est.estimateMethod).toBe('modeled');
    expect(est.rawWaste.unit).toBe('coreMs');
    expect(est.rawWaste.value).toBeGreaterThan(0);
  });

  it('autoscalingChurn: resourceOnly, modeled executor-hours waste, converted to core-hours', () => {
    const findings = [{ type: 'autoscalingChurn', shortLivedExecutorCount: 8, impactBand: 'warning' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate.basis).toBe('resourceOnly');
    expect(findings[0].impactEstimate.rawWaste.unit).toBe('coreHours');
    expect(findings[0].impactEstimate.rawWaste.value).toBeGreaterThan(0);
  });

  it('configAudit: informational, no rawWaste', () => {
    const findings = [{ type: 'configAudit', rule: 'shuffle-service', impactBand: 'info' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });
});

describe('estimateImpact: cost-only group B', () => {
  it('jobFailureRate: resourceOnly, failedJobs * avgJobDurationMs', () => {
    const findings = [{ type: 'jobFailureRate', failedJobs: 3, avgJobDurationMs: 5000, impactBand: 'warning' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate.basis).toBe('resourceOnly');
    expect(findings[0].impactEstimate.rawWaste.value).toBeGreaterThan(0);
  });

  it('jobFailureRate: a null-derived avgJobDurationMs of 0 stays resourceOnly (rawWaste always attached) but with value 0', () => {
    const findings = [{ type: 'jobFailureRate', failedJobs: 3, avgJobDurationMs: 0, impactBand: 'warning' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate.rawWaste.value).toBe(0);
  });

  it('cachingOpportunity: unconditionally resourceOnly, no stage-mappable branch', () => {
    const findings = [{ type: 'cachingOpportunity', totalReadBytes: 1_000_000_000, impactBand: 'info' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: expect.any(Number), unit: 'ms' },
    });
  });

  it('cacheUtilization: resourceOnly, uncached-or-spilled bytes / re-read throughput', () => {
    const findings = [{ type: 'cacheUtilization', memorySize: 100, diskSize: 900, numCachedPartitions: 8, numPartitions: 10, impactBand: 'warning' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate.basis).toBe('resourceOnly');
    expect(findings[0].impactEstimate.rawWaste.unit).toBe('ms');
  });

  it('cacheUtilization storageUnobserved: missing evidence, informational', () => {
    const findings = [{ type: 'cacheUtilization', variant: 'storageUnobserved', dataUnavailable: true, value: 2, impactBand: 'info' }];
    estimate(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });

  for (const type of ['stageFailed', 'failures', 'incompleteRun']) {
    it(`${type}: informational, no rawWaste`, () => {
      const findings = [{ type, impactBand: 'critical' }];
      estimate(findings, new Map());
      expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
    });
  }

  it('stageShape lowParallelism rule: resourceOnly, idle core-time, real data', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskCount: 2 }]]);
    const findings = [{ type: 'stageShape', rule: 'lowParallelism', stageId: 0, totalCores: 10, impactBand: 'warning' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.basis).toBe('resourceOnly');
    expect(est.estimateMethod).toBe('measured');
    expect(est.rawWaste.unit).toBe('coreMs');
    expect(est.rawWaste.value).toBe((10 - 2) * 10000);
  });

  it('stageShape dataExplosion rule: resourceOnly, excess output bytes, no ms figure', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], inputBytes: 1000, outputBytes: 9000 }]]);
    const findings = [{ type: 'stageShape', rule: 'dataExplosion', stageId: 0, impactBand: 'warning' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured',
      rawWaste: { value: 8000, unit: 'bytes' },
    });
  });

  it('stageShape taskStageSkew rule: resourceOnly, idle core-time at achieved concurrency, no wall-clock claim', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [],
      taskCount: 5, taskDurationP50: 500, taskDurationMax: 8000,
    }]]);
    const findings = [{ type: 'stageShape', rule: 'taskStageSkew', stageId: 0, totalCores: 10, impactBand: 'info' }];
    estimate(findings, stages);
    const est = findings[0].impactEstimate;
    // idleCoreMs = max(0, min(totalCores, taskCount) - 1) * (taskDurationMax - taskDurationP50)
    //            = (min(10, 5) - 1) * (8000 - 500) = 4 * 7500 = 30000.
    expect(est).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured',
      rawWaste: { value: 30000, unit: 'coreMs', idle: true },
    });
  });

  it('stageShape taskStageSkew rule: clamps to 0 idle core-ms when totalCores is missing/small (never negative)', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [],
      taskCount: 5, taskDurationP50: 500, taskDurationMax: 8000,
    }]]);
    const findings = [{ type: 'stageShape', rule: 'taskStageSkew', stageId: 0, totalCores: 1, impactBand: 'info' }];
    estimate(findings, stages);
    expect(findings[0].impactEstimate.rawWaste.value).toBe(0);
  });

  it('slowHost multiDim byte-based dimensions: informational', () => {
    const findings = [{ type: 'slowHost', variant: 'multiDim', dimension: 'inputBytes', stageId: 0, impactBand: 'info' }];
    estimate(findings, new Map([[0, { id: 0, submittedAt: 0, completedAt: 1000, parentIds: [] }]]));
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });
});

describe('estimateImpact: totalCores wiring', () => {
  it('a non-zero context totalCores reaches computeCeiling\'s totalCores>0 branch and tightens the clip', () => {
    // Solo stage (gate 1, basis stays 'serial'): duration 10_000ms, no
    // taskDurationMax, large executorRunTime (40_000 core-ms). computeCeiling
    // (src/occupancy.ts): totalCores<=0 -> taskDurationMax (0 here); totalCores>0
    // -> max(taskDurationMax, executorRunTime/totalCores). A 20_000ms raw claim
    // exceeds either ceiling, so the clipped wallClock depends only on the ceiling:
    // a different totalCores changes the result iff the context's totalCores reaches computeCeiling.
    const stage = { id: 0, submittedAt: 0, completedAt: 10_000, parentIds: [], executorRunTime: 40_000, retryWasteMs: 20_000 };
    const stages = new Map([[0, stage]]);
    const finding = () => [{ type: 'retryWaste', stageId: 0, metric: 'retryWasteMs', value: 20_000, impactBand: 'warning' }];

    // totalCores 0: ceiling 0, room = 10_000; the 20_000ms
    // claim clips to the stage's full 10_000ms duration.
    const unwired = finding();
    estimate(unwired, stages);
    expect(unwired[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 10_000, high: 10_000 }, estimateMethod: 'measured',
      rawWaste: { value: 20_000, unit: 'ms' },
    });

    // totalCores 8: ceiling = max(0, 40_000/8) = 5_000, room = 5_000:
    // a tighter cap, proving it reaches computeCeiling's totalCores>0 branch.
    const wired = finding();
    estimate(wired, stages, 8);
    expect(wired[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 5_000, high: 5_000 }, estimateMethod: 'measured',
      rawWaste: { value: 20_000, unit: 'ms' },
    });
  });
});
