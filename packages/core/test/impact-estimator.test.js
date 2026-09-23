import { describe, it, expect } from 'vitest';
import { estimateImpact } from '../src/impact-estimator.js';

describe('estimateImpact: skeleton', () => {
  it('returns the same findings array reference, unmodified for an unrecognized type', () => {
    const findings = [{ type: 'not-a-real-detector', impactBand: 'info' }];
    const stages = new Map();
    const result = estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.basis).toBe('contended');
    expect(est.wallClock).toEqual({ low: 600, high: 1200 });
    expect(est.rawWaste).toEqual({ value: 1200, unit: 'ms' });
  });

  it('speculationWaste: clips the stage\'s own speculationWasteMs the same way', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [], speculationWasteMs: 800 }]]);
    const findings = [{ type: 'speculationWaste', stageId: 0, metric: 'speculationWasteMs', value: 800, impactBand: 'info' }];
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 800, high: 800 }, estimateMethod: 'measured',
      rawWaste: { value: 800, unit: 'ms' },
    });
  });

  it('coldStart: reports a serial point estimate unconditionally (app-scoped, no stage lookup, can never overlap a stage)', () => {
    const findings = [{ type: 'coldStart', stageId: null, metric: 'startupGapSeconds', value: 12, impactBand: 'warning' }];
    estimateImpact(findings, new Map());
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
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });

  it('reports resourceOnly (not a wall-clock claim) when executorRunTime is zero (guards divide-by-zero)', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 1000, parentIds: [], jvmGCTime: 0, executorRunTime: 0 }]]);
    const findings = [{ type: 'gc', stageId: 0, impactBand: 'info' }];
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 0, unit: 'coreMs' },
    });
  });
});

describe('estimateImpact: skew / straggler: the tail claim is floored at the longest task the fix leaves', () => {
  // These claims shorten the stage's longest task itself, so ceiling(S)'s taskDurationMax term
  // (the very task being fixed) can't be their floor: that used to cap a one-straggler stage's
  // claim at ~0. The floor is taskDurationMax - claim, or the core work over every core.
  it('skew: P95 branch, floored at the longest task the fix leaves (9000 - 3000 = 6000 on a 10000ms stage)', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [],
      taskCount: 50, taskDurationP50: 1000, taskDurationP95: 4000, taskDurationMax: 9000,
    }]]);
    const findings = [{ type: 'skew', stageId: 0, metric: 'P95/median', impactBand: 'warning' }];
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
    const est = findings[0].impactEstimate;
    // Raw claim max-P50 = 8000; post-fix floor is P50 (1000), room 9000: the old
    // taskDurationMax floor (9000) would have left only 1000.
    expect(est.wallClock).toEqual({ low: 8000, high: 8000 });
    expect(est.rawWaste).toEqual({ value: 8000, unit: 'ms' });
  });

  it('straggler: reconstructs max-P50, floored at P50 rather than at the straggler itself', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1000, taskDurationMax: 7000 }]]);
    const findings = [{ type: 'straggler', stageId: 0, metric: 'stragglerShare', impactBand: 'warning' }];
    estimateImpact(findings, stages);
    // Raw claim max-P50 = 6000, room above the P50 floor is 9000: min(6000, 9000) = 6000.
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 6000, high: 6000 });
  });

  it('straggler: the stage\'s core work spread over every core still caps the claim', () => {
    // 36000 core-ms over 4 cores = 9000ms of unavoidable work on a 10000ms stage: room 1000.
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1000, taskDurationMax: 9000, executorRunTime: 36000,
    }]]);
    const findings = [{ type: 'straggler', stageId: 0, metric: 'stragglerShare', impactBand: 'warning' }];
    estimateImpact(findings, stages, 4);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 1000, high: 1000 });
    expect(findings[0].impactEstimate.rawWaste).toEqual({ value: 8000, unit: 'ms' });
  });

  it('stageShape with an unrecognized rule: leaves impactEstimate unset (null, not undefined, internally)', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 500, taskDurationMax: 8000 }]]);
    const findings = [{ type: 'stageShape', rule: 'someOtherRule', stageId: 0, impactBand: 'warning' }];
    const result = estimateImpact(findings, stages);
    expect(result[0].impactEstimate).toBeUndefined();
  });
});

describe('estimateImpact: slowHost duration-based variants (no taskDurationMax set, so ceiling is 0 and the clip is a no-op)', () => {
  it('hostMeanRatio branch: excess duration of the slow host over the stage median', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 2000 }]]);
    const findings = [{ type: 'slowHost', stageId: 0, metric: 'hostMeanRatio', value: 3, hostMeanMs: 6000, impactBand: 'warning' }];
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 4000, high: 4000 });
  });

  it('durationShare variant: same reconstruction, from hostMeanMs rather than the 0-1 share in `value`', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1000 }]]);
    const findings = [{
      type: 'slowHost', stageId: 0, variant: 'durationShare',
      metric: 'hostDurationShare', value: 0.82, hostMeanMs: 5000, impactBand: 'warning',
    }];
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 4000, high: 4000 });
  });

  it('multiDim variant, taskTime dimension: execMaxValue is a genuine per-executor average duration', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskDurationP50: 1500 }]]);
    const findings = [{
      type: 'slowHost', stageId: 0, variant: 'multiDim', dimension: 'taskTime',
      metric: 'execMaxMedianRatio', value: 3.7, execMaxValue: 5500, impactBand: 'warning',
    }];
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 4000, high: 4000 });
  });

  it('multiDim variant, byte-based dimensions: informational, no absolute ms figure', () => {
    const findings = [{
      type: 'slowHost', stageId: 0, variant: 'multiDim', dimension: 'inputBytes',
      metric: 'execMaxMedianRatio', value: 3.2, execMaxValue: 900_000_000, impactBand: 'info',
    }];
    estimateImpact(findings, new Map([[0, { id: 0, submittedAt: 0, completedAt: 1000, parentIds: [] }]]));
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
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
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
    estimateImpact(twice, stages);
    expect(twice[0].impactEstimate.wallClock).toEqual({ low: 100_000, high: 100_000 });

    const malformed = [{ type: 'duplicatePlanSubtree', stageIds: [0, 1], impactBand: 'warning' }];
    estimateImpact(malformed, stages);
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

    estimateImpact(findings, stages);

    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 5_000, high: 5_000 });
  });
});

describe('estimateImpact: shuffle, spill (no taskDurationMax set, ceiling 0, solo stage: numbers unaffected by the redesign)', () => {
  it('shuffle: bytes / assumed throughput (parser fallback tier)', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], shuffleReadBytes: 1_250_000_000 }]]);
    const findings = [{ type: 'shuffle', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.estimateMethod).toBe('modeled');
    expect(est.basis).toBe('serial');
    expect(est.wallClock.high).toBeGreaterThan(0);
    expect(est.rawWaste).toEqual({ value: 1_250_000_000, unit: 'bytes' });
  });

  it('spill: uses diskBytesSpilled, not memoryBytesSpilled', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 100000, parentIds: [],
      diskBytesSpilled: 200_000_000, memoryBytesSpilled: 900_000_000,
    }]]);
    const findings = [{ type: 'spill', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
    // 5 GB over 4 x 125 MB/s = 10s (one shared link would claim 40s); 8 GB over 4 x 200 MB/s = 10s.
    expect(findings[0].impactEstimate.wallClock.high).toBeCloseTo(10000, 6);
    expect(findings[1].impactEstimate.wallClock.high).toBeCloseTo(10000, 6);
    expect(findings[0].impactEstimate.rawWaste).toEqual({ value: 5_000_000_000, unit: 'bytes' });
  });
});

describe('estimateImpact: stageSlowness', () => {
  it('waste is stage duration minus the detector threshold, converted to ms', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 20 * 60 * 1000, parentIds: [] }]]);
    const findings = [{ type: 'stageSlowness', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.estimateMethod).toBe('modeled');
    expect(est.wallClock.high).toBeGreaterThan(0);
  });
});

describe('estimateImpact: partitionSizing, tinyTask', () => {
  it('maxPartitionTooBig rule: shuffleReadMax / throughput', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], shuffleReadMax: 500_000_000 }]]);
    const findings = [{ type: 'partitionSizing', rule: 'maxPartitionTooBig', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate.wallClock.high).toBeGreaterThan(0);
  });

  it('shufflePartitionSkew rule: (max - p50) / throughput', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], shuffleReadMax: 500_000_000, shuffleReadP50: 100_000_000 }]]);
    const findings = [{ type: 'partitionSizing', rule: 'shufflePartitionSkew', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, stages);
    const expectedMs = ((500_000_000 - 100_000_000) / 125_000_000) * 1000;
    expect(findings[0].impactEstimate.wallClock.high).toBeCloseTo(expectedMs, 0);
  });

  it('lowShuffleParallelism rule: derives its own target task count', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 100000, parentIds: [],
      shuffleReadBytes: 2_000_000_000, taskCount: 4,
    }]]);
    const findings = [{ type: 'partitionSizing', rule: 'lowShuffleParallelism', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate.wallClock.high).toBeGreaterThanOrEqual(0);
  });

  it('tinyTask: excess task count beyond a coalesce-to-1/10th target', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 100000, parentIds: [], taskCount: 1000 }]]);
    const findings = [{ type: 'tinyTask', stageId: 0, impactBand: 'info' }];
    estimateImpact(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.wallClock.high).toBe(900 * 50); // (1000 - round(1000/10)) excess tasks * 50ms
    expect(est.rawWaste).toEqual({ value: 900 * 50, unit: 'ms' });
  });
});

describe('estimateImpact: Plan Advisor trio', () => {
  it('smallFiles: apportioned evenly across two non-overlapping stages, stage-mappable', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [] }],
      [1, { id: 1, submittedAt: 5000, completedAt: 9000, parentIds: [0] }],
    ]);
    const findings = [{ type: 'smallFiles', stageIds: [0, 1], metric: 'avgFileSizeBytes', value: 1024, fileCount: 500, impactBand: 'warning' }];
    estimateImpact(findings, stages);
    // 500 * 10ms = 5000ms total, 2500 per stage, both solo and non-overlapping.
    expect(findings[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'modeled',
      rawWaste: { value: 5000, unit: 'ms' },
    });
  });

  it('smallFiles: resourceOnly when not stage-mappable, still reports the magnitude as rawWaste', () => {
    const findings = [{ type: 'smallFiles', stageIds: [], metric: 'avgFileSizeBytes', value: 1024, fileCount: 500, impactBand: 'warning' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 500 * 10, unit: 'ms' },
    });
  });

  it('overBroadcast/underBroadcast: resourceOnly when not stage-mappable, magnitude kept as rawWaste', () => {
    const over = [{ type: 'overBroadcast', metric: 'broadcastBytes', value: 250_000_000, impactBand: 'warning' }];
    estimateImpact(over, new Map());
    expect(over[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 2000, unit: 'ms' },
    });

    const under = [{ type: 'underBroadcast', stageIds: [], metric: 'smallerSideBytes', value: 125_000_000, impactBand: 'warning' }];
    estimateImpact(under, new Map());
    expect(under[0].impactEstimate.rawWaste).toEqual({ value: 1000, unit: 'ms' });
  });

  it('a zero-magnitude, non-stage-mappable finding is informational, no rawWaste', () => {
    const findings = [{ type: 'smallFiles', stageIds: [], metric: 'avgFileSizeBytes', value: 1024, fileCount: 0, impactBand: 'info' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('overBroadcast: stage-mappable: the ceiling now caps the claim at the stage\'s own duration, fixing the historical overclaim bug', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [] }]]);
    const findings = [{ type: 'overBroadcast', stageIds: [0], metric: 'broadcastBytes', value: 700_000_000, impactBand: 'warning' }];
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
    // 4000 * 10ms = 40_000ms total, both stages solo and non-overlapping.
    expect(findings[0].impactEstimate.wallClock).toEqual({ low: 40_000, high: 40_000 });
  });
});

describe('estimateImpact: cost-only group A', () => {
  it('memoryUtilization wasteModel variant: resourceOnly, passes through the existing wastedMBSeconds as rawWaste', () => {
    const findings = [{ type: 'memoryUtilization', variant: 'wasteModel', metric: 'wastedMBSeconds', value: 12345, impactBand: 'warning' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured',
      rawWaste: { value: 12345, unit: 'mbSeconds' },
    });
  });

  it('memoryUtilization: an unrecognized variant is informational, no rawWaste', () => {
    const findings = [{ type: 'memoryUtilization', variant: 'bandTooSmall', impactBand: 'info' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('memoryUtilization idleCores: resourceOnly, idle rate * allocated memory * executors * duration, in MB-seconds', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'idleCores', metric: 'idleCoreRate', value: 75, impactBand: 'warning',
      idleRateFraction: 0.75, allocatedMB: 4096, peakExecutors: 4, appDurationMs: 600_000,
    }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 7_372_800, unit: 'mbSeconds' },
    });
  });

  it('memoryUtilization idleCores: informational when the sizing inputs are missing', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'idleCores', metric: 'idleCoreRate', value: 75, impactBand: 'warning',
      idleRateFraction: 0.75, allocatedMB: null, peakExecutors: 4, appDurationMs: 600_000,
    }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('memoryUtilization memoryBand heapOverProvisioned: resourceOnly, unused heap held for the run, in MB-seconds', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned',
      executorId: '3', metric: 'heapUsedRatio', value: 25, impactBand: 'info',
      allocatedBytes: 1000 * 1024 * 1024, heap: 250 * 1024 * 1024, appDurationMs: 120_000,
    }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: 90_000, unit: 'mbSeconds' },
    });
  });

  it('memoryUtilization memoryBand heapNearCapacity: an OOM-risk signal, not a waste: informational', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity',
      executorId: '3', metric: 'heapUsedRatio', value: 98, impactBand: 'warning',
    }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('memoryUtilization memoryBand dataUnavailable: no rule, no inputs, informational', () => {
    const findings = [{
      type: 'memoryUtilization', variant: 'memoryBand', metric: 'memoryBand',
      dataUnavailable: true, impactBand: 'info',
    }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'modeled' });
  });

  it('utilization: resourceOnly, idle core-hours from the real utilizationFraction, no assumed constant', () => {
    const findings = [{
      type: 'utilization', utilizationFraction: 0.4, impactBand: 'warning',
      appDurationMs: 3_600_000, totalCores: 10,
    }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured',
      rawWaste: { value: 6, unit: 'coreHours' },
    });
  });

  it('utilization: missing appDurationMs/totalCores falls back to informational', () => {
    const findings = [{ type: 'utilization', utilizationFraction: 0.4, impactBand: 'warning' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'measured' });
  });

  it('coreLocality: resourceOnly, modeled network-fetch penalty as extra core-time, not wall-clock', () => {
    const findings = [{ type: 'coreLocality', nonLocalTaskCount: 40, impactBand: 'info' }];
    estimateImpact(findings, new Map());
    const est = findings[0].impactEstimate;
    expect(est.basis).toBe('resourceOnly');
    expect(est.wallClock).toBeNull();
    expect(est.estimateMethod).toBe('modeled');
    expect(est.rawWaste.unit).toBe('coreMs');
    expect(est.rawWaste.value).toBeGreaterThan(0);
  });

  it('autoscalingChurn: resourceOnly, modeled executor-hours waste, converted to core-hours', () => {
    const findings = [{ type: 'autoscalingChurn', shortLivedExecutorCount: 8, impactBand: 'warning' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate.basis).toBe('resourceOnly');
    expect(findings[0].impactEstimate.rawWaste.unit).toBe('coreHours');
    expect(findings[0].impactEstimate.rawWaste.value).toBeGreaterThan(0);
  });

  it('configAudit: informational, no rawWaste', () => {
    const findings = [{ type: 'configAudit', rule: 'shuffle-service', impactBand: 'info' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });
});

describe('estimateImpact: cost-only group B', () => {
  it('jobFailureRate: resourceOnly, failedJobs * avgJobDurationMs', () => {
    const findings = [{ type: 'jobFailureRate', failedJobs: 3, avgJobDurationMs: 5000, impactBand: 'warning' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate.basis).toBe('resourceOnly');
    expect(findings[0].impactEstimate.rawWaste.value).toBeGreaterThan(0);
  });

  it('jobFailureRate: a null-derived avgJobDurationMs of 0 stays resourceOnly (rawWaste always attached) but with value 0', () => {
    const findings = [{ type: 'jobFailureRate', failedJobs: 3, avgJobDurationMs: 0, impactBand: 'warning' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate.rawWaste.value).toBe(0);
  });

  it('cachingOpportunity: unconditionally resourceOnly, no stage-mappable branch', () => {
    const findings = [{ type: 'cachingOpportunity', totalReadBytes: 1_000_000_000, impactBand: 'info' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled',
      rawWaste: { value: expect.any(Number), unit: 'ms' },
    });
  });

  it('cacheUtilization: resourceOnly, uncached-or-spilled bytes / re-read throughput', () => {
    const findings = [{ type: 'cacheUtilization', memorySize: 100, diskSize: 900, numCachedPartitions: 8, numPartitions: 10, impactBand: 'warning' }];
    estimateImpact(findings, new Map());
    expect(findings[0].impactEstimate.basis).toBe('resourceOnly');
    expect(findings[0].impactEstimate.rawWaste.unit).toBe('ms');
  });

  for (const type of ['stageFailed', 'failures', 'incompleteRun']) {
    it(`${type}: informational, no rawWaste`, () => {
      const findings = [{ type, impactBand: 'critical' }];
      estimateImpact(findings, new Map());
      expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
    });
  }

  it('stageShape lowParallelism rule: resourceOnly, idle core-time, real data', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], taskCount: 2 }]]);
    const findings = [{ type: 'stageShape', rule: 'lowParallelism', stageId: 0, totalCores: 10, impactBand: 'warning' }];
    estimateImpact(findings, stages);
    const est = findings[0].impactEstimate;
    expect(est.basis).toBe('resourceOnly');
    expect(est.estimateMethod).toBe('measured');
    expect(est.rawWaste.unit).toBe('coreMs');
    expect(est.rawWaste.value).toBe((10 - 2) * 10000);
  });

  it('stageShape dataExplosion rule: resourceOnly, excess output bytes, no ms figure', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 10000, parentIds: [], inputBytes: 1000, outputBytes: 9000 }]]);
    const findings = [{ type: 'stageShape', rule: 'dataExplosion', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, stages);
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
    estimateImpact(findings, stages);
    const est = findings[0].impactEstimate;
    // idleCoreMs = max(0, min(totalCores, taskCount) - 1) * (taskDurationMax - taskDurationP50)
    //            = (min(10, 5) - 1) * (8000 - 500) = 4 * 7500 = 30000.
    expect(est).toEqual({
      basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured',
      rawWaste: { value: 30000, unit: 'coreMs' },
    });
  });

  it('stageShape taskStageSkew rule: clamps to 0 idle core-ms when totalCores is missing/small (never negative)', () => {
    const stages = new Map([[0, {
      id: 0, submittedAt: 0, completedAt: 10000, parentIds: [],
      taskCount: 5, taskDurationP50: 500, taskDurationMax: 8000,
    }]]);
    const findings = [{ type: 'stageShape', rule: 'taskStageSkew', stageId: 0, totalCores: 1, impactBand: 'info' }];
    estimateImpact(findings, stages);
    expect(findings[0].impactEstimate.rawWaste.value).toBe(0);
  });

  it('slowHost multiDim byte-based dimensions: informational', () => {
    const findings = [{ type: 'slowHost', variant: 'multiDim', dimension: 'inputBytes', stageId: 0, impactBand: 'info' }];
    estimateImpact(findings, new Map([[0, { id: 0, submittedAt: 0, completedAt: 1000, parentIds: [] }]]));
    expect(findings[0].impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });
  });
});

describe('estimateImpact: totalCores wiring', () => {
  it('a non-zero 3rd argument reaches computeCeiling\'s totalCores>0 branch and tightens the clip', () => {
    // Solo stage (gate 1, basis stays 'serial'): duration 10_000ms, no
    // taskDurationMax, large executorRunTime (40_000 core-ms). computeCeiling
    // (src/occupancy.ts): totalCores<=0 -> taskDurationMax (0 here); totalCores>0
    // -> max(taskDurationMax, executorRunTime/totalCores). A 20_000ms raw claim
    // exceeds either ceiling, so the clipped wallClock depends only on the ceiling:
    // a different totalCores changes the result iff the 3rd arg reaches computeCeiling.
    const stage = { id: 0, submittedAt: 0, completedAt: 10_000, parentIds: [], executorRunTime: 40_000, retryWasteMs: 20_000 };
    const stages = new Map([[0, stage]]);
    const finding = () => [{ type: 'retryWaste', stageId: 0, metric: 'retryWasteMs', value: 20_000, impactBand: 'warning' }];

    // 2-arg form (totalCores implicitly 0): ceiling 0, room = 10_000; the 20_000ms
    // claim clips to the stage's full 10_000ms duration.
    const unwired = finding();
    estimateImpact(unwired, stages);
    expect(unwired[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 10_000, high: 10_000 }, estimateMethod: 'measured',
      rawWaste: { value: 20_000, unit: 'ms' },
    });

    // 3-arg form, totalCores 8: ceiling = max(0, 40_000/8) = 5_000, room = 5_000:
    // a tighter cap, proving the arg reaches computeCeiling's totalCores>0 branch.
    const wired = finding();
    estimateImpact(wired, stages, 8);
    expect(wired[0].impactEstimate).toEqual({
      basis: 'serial', wallClock: { low: 5_000, high: 5_000 }, estimateMethod: 'measured',
      rawWaste: { value: 20_000, unit: 'ms' },
    });
  });
});
