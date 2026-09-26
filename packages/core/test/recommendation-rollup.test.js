import { describe, it, expect } from 'vitest';
import { computeStageUnionMs } from '../src/recommendation-rollup.ts';

describe('computeStageUnionMs', () => {
  it('sums non-overlapping stage durations', () => {
    const stages = new Map([
      [1, { submittedAt: 0, completedAt: 100 }],
      [2, { submittedAt: 200, completedAt: 350 }],
    ]);
    expect(computeStageUnionMs([1, 2], stages)).toBe(100 + 150);
  });

  it('caps overlapping stage durations at the union, not the sum', () => {
    const stages = new Map([
      [1, { submittedAt: 0, completedAt: 100 }],
      [2, { submittedAt: 50, completedAt: 150 }],
    ]);
    // sum would be 200; stages overlap 50-100, so the union is 0-150 = 150.
    expect(computeStageUnionMs([1, 2], stages)).toBe(150);
  });

  it('ignores stage ids missing from the map', () => {
    const stages = new Map([[1, { submittedAt: 0, completedAt: 100 }]]);
    expect(computeStageUnionMs([1, 999], stages)).toBe(100);
  });

  it('returns 0 for an empty stage id list', () => {
    expect(computeStageUnionMs([], new Map())).toBe(0);
  });

  it('skips half-open stages instead of defaulting a missing bound to 0', () => {
    // A truncated log leaves `completedAt` unset; coercing it to 0 would add a [1000, 0] interval and drag the union negative.
    const stages = new Map([
      [1, { submittedAt: 0, completedAt: 100 }],
      [2, { submittedAt: 1000 }],
      [3, { completedAt: 2000 }],
    ]);
    const union = computeStageUnionMs([1, 2, 3], stages);
    expect(union).toBeGreaterThanOrEqual(0);
    expect(union).toBe(100);
  });
});

import { buildRecommendationRollup } from '../src/recommendation-rollup.ts';

describe('buildRecommendationRollup', () => {
  const stages = new Map([
    [1, { submittedAt: 0, completedAt: 1000 }],
    [2, { submittedAt: 500, completedAt: 1500 }],
    [3, { submittedAt: 2000, completedAt: 2200 }],
  ]);

  it('sums wallClock.high across a time-based group, capped at the stage union', () => {
    const findings = [
      { type: 'spill', impactBand: 'warning', stageId: 1, impactEstimate: { basis: 'serial', wallClock: { low: 900, high: 900 }, estimateMethod: 'modeled' } },
      { type: 'spill', impactBand: 'warning', stageId: 2, impactEstimate: { basis: 'serial', wallClock: { low: 900, high: 900 }, estimateMethod: 'modeled' } },
    ];
    const [group] = buildRecommendationRollup(findings, stages);
    expect(group.kind).toBe('time');
    expect(group.type).toBe('spill');
    expect(group.findingCount).toBe(2);
    expect(group.stageCount).toBe(2);
    // naive sum would be 1800; stages 1+2 overlap 500-1000, union is 0-1500 = 1500.
    expect(group.recoverableMsHigh).toBe(1500);
  });

  it('sums rawWaste within a resourceOnly group, kept in its own unit', () => {
    const findings = [
      { type: 'utilization', impactBand: 'info', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 4, unit: 'coreHours' } } },
      { type: 'utilization', impactBand: 'info', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 6, unit: 'coreHours' } } },
    ];
    const [group] = buildRecommendationRollup(findings, stages);
    expect(group).toEqual({ kind: 'resource', type: 'utilization', findingCount: 2, unit: 'coreHours', total: 10, findings });
  });

  it('counts an informational group by impact band with no numeric aggregation', () => {
    const findings = [
      { type: 'stageFailed', impactBand: 'critical', impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' } },
      { type: 'stageFailed', impactBand: 'warning', impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' } },
    ];
    const [group] = buildRecommendationRollup(findings, stages);
    expect(group).toEqual({ kind: 'count', type: 'stageFailed', findingCount: 2, byImpactBand: { critical: 1, warning: 1 }, findings });
  });

  it('splits a mixed-basis group (e.g. gc) by basis before aggregating each half', () => {
    const findings = [
      { type: 'gc', impactBand: 'warning', stageId: 3, impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'modeled' } },
      { type: 'gc', impactBand: 'warning', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 50, unit: 'coreMs' } } },
    ];
    const groups = buildRecommendationRollup(findings, stages);
    const gcGroups = groups.filter((g) => g.type === 'gc');
    expect(gcGroups).toHaveLength(2);
    expect(gcGroups.find((g) => g.kind === 'time')).toMatchObject({ findingCount: 1, recoverableMsHigh: 100 });
    expect(gcGroups.find((g) => g.kind === 'resource')).toMatchObject({ findingCount: 1, unit: 'coreMs', total: 50 });
  });

  it('sorts time-based groups first, then resource-only, then count-only', () => {
    const findings = [
      { type: 'stageFailed', impactBand: 'critical', impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' } },
      { type: 'utilization', impactBand: 'info', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 4, unit: 'coreHours' } } },
      { type: 'spill', impactBand: 'warning', stageId: 1, impactEstimate: { basis: 'serial', wallClock: { low: 900, high: 900 }, estimateMethod: 'modeled' } },
    ];
    const kinds = buildRecommendationRollup(findings, stages).map((g) => g.kind);
    expect(kinds).toEqual(['time', 'resource', 'count']);
  });

  it('orders resource/count groups by worst impact band when the kind ties, never by their incomparable raw magnitudes', () => {
    const findings = [
      { type: 'memoryUtilization', impactBand: 'warning', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 1024, unit: 'bytes' } } },
      { type: 'utilization', impactBand: 'critical', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 4, unit: 'coreHours' } } },
    ];
    const groups = buildRecommendationRollup(findings, stages);
    expect(groups.map((g) => g.type)).toEqual(['utilization', 'memoryUtilization']);
  });

  it('returns an empty array for no findings', () => {
    expect(buildRecommendationRollup([], stages)).toEqual([]);
  });

  it('recovers stageless time-based findings with the naive sum, not capped to 0', () => {
    const findings = [
      { type: 'coldStart', impactBand: 'warning', impactEstimate: { basis: 'serial', wallClock: { low: 500, high: 500 }, estimateMethod: 'modeled' } },
    ];
    const [group] = buildRecommendationRollup(findings, stages);
    expect(group.kind).toBe('time');
    expect(group.findingCount).toBe(1);
    expect(group.stageCount).toBe(0);
    expect(group.recoverableMsHigh).toBe(500);
  });

  it('splits same-type resource findings by unit to prevent mixing incompatible units', () => {
    const findings = [
      { type: 'stageShape', impactBand: 'warning', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 100, unit: 'coreMs' } } },
      { type: 'stageShape', impactBand: 'warning', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 1024, unit: 'bytes' } } },
    ];
    const groups = buildRecommendationRollup(findings, stages);
    const stageShapeGroups = groups.filter((g) => g.type === 'stageShape');
    expect(stageShapeGroups).toHaveLength(2);
    expect(stageShapeGroups.find((g) => g.unit === 'coreMs')).toMatchObject({ findingCount: 1, total: 100 });
    expect(stageShapeGroups.find((g) => g.unit === 'bytes')).toMatchObject({ findingCount: 1, total: 1024 });
  });

  it('routes a config-scope (configAudit) finding into a RollupGroup, not just runtime bottleneck types', () => {
    const findings = [
      { type: 'configAudit', property: 'spark.serializer', impactBand: 'info', recommendation: 'x' },
    ];
    const groups = buildRecommendationRollup(findings, stages);
    expect(groups).toEqual([
      { kind: 'count', type: 'configAudit', findingCount: 1, byImpactBand: { info: 1 }, findings },
    ]);
  });
});

import { isEligible, isRealFinding } from '../src/recommendation-rollup.ts';

describe('isRealFinding', () => {
  it('excludes memoryUtilization\'s dataUnavailable memoryBand caveat', () => {
    expect(isRealFinding({ type: 'memoryUtilization', variant: 'memoryBand', dataUnavailable: true, impactBand: 'info' })).toBe(false);
  });

  it('includes an ordinary memoryUtilization finding without the caveat', () => {
    expect(isRealFinding({ type: 'memoryUtilization', variant: 'idleCores', impactBand: 'warning' })).toBe(true);
  });

  it('includes every other type, including incompleteRun', () => {
    expect(isRealFinding({ type: 'incompleteRun', impactBand: 'warning' })).toBe(true);
    expect(isRealFinding({ type: 'skew', impactBand: 'critical' })).toBe(true);
  });
});

describe('isEligible', () => {
  it('excludes incompleteRun, unlike isRealFinding', () => {
    expect(isEligible({ type: 'incompleteRun', impactBand: 'warning' })).toBe(false);
  });

  it('still excludes the dataUnavailable caveat via isRealFinding', () => {
    expect(isEligible({ type: 'memoryUtilization', variant: 'memoryBand', dataUnavailable: true, impactBand: 'info' })).toBe(false);
  });

  it('excludes cacheUtilization\'s storageUnobserved caveat, which isRealFinding keeps for its widget card', () => {
    const caveat = { type: 'cacheUtilization', variant: 'storageUnobserved', dataUnavailable: true, impactBand: 'info' };
    expect(isRealFinding(caveat)).toBe(true);
    expect(isEligible(caveat)).toBe(false);
  });

  it('includes an ordinary finding', () => {
    expect(isEligible({ type: 'skew', impactBand: 'critical' })).toBe(true);
  });
});
