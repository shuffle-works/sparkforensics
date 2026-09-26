import { describe, it, expect } from 'vitest';
import { computeLocalityAreaSeries } from '../src/core-usage-locality.js';

describe('computeLocalityAreaSeries', () => {
  it('distributes stage core-time across its window, split by locality', () => {
    // one stage [0,1000), executorRunTime 2000ms (=> avg 2 busy cores over 1000ms),
    // localityStats: 3 PROCESS_LOCAL + 1 ANY => 75% / 25%
    const stages = [{ submittedAt: 0, completedAt: 1000, executorRunTime: 2000,
      localityStats: [{ locality: 'PROCESS_LOCAL', count: 3 }, { locality: 'ANY', count: 1 }] }];
    const r = computeLocalityAreaSeries(stages, { bucketWidthMs: 1000 });
    expect(r.labels).toEqual([0]);
    expect(r.series.PROCESS_LOCAL[0]).toBeCloseTo(1.5); // 2 * 0.75
    expect(r.series.ANY[0]).toBeCloseTo(0.5);           // 2 * 0.25
    expect(r.series.idle[0]).toBeCloseTo(0);            // peak busy == total busy
  });

  it('shows idle remainder in an under-busy bucket', () => {
    const stages = [
      { submittedAt: 0, completedAt: 1000, executorRunTime: 4000, localityStats: [{ locality: 'ANY', count: 1 }] },
      { submittedAt: 1000, completedAt: 2000, executorRunTime: 1000, localityStats: [{ locality: 'ANY', count: 1 }] },
    ];
    const r = computeLocalityAreaSeries(stages, { bucketWidthMs: 1000 });
    // bucket0 busy=4 (peak), bucket1 busy=1 => idle=3
    expect(r.series.ANY[0]).toBeCloseTo(4);
    expect(r.series.idle[0]).toBeCloseTo(0);
    expect(r.series.ANY[1]).toBeCloseTo(1);
    expect(r.series.idle[1]).toBeCloseTo(3);
  });

  it('reports the latest completion among counted stages as endTime', () => {
    const r = computeLocalityAreaSeries([
      { submittedAt: 0, completedAt: 4000, executorRunTime: 4000, localityStats: [] },
      { submittedAt: 1000, completedAt: 9000, executorRunTime: 0, localityStats: [] },
    ], { bucketWidthMs: 1000 });
    expect(r.endTime).toBe(4000);
  });

  it('returns empty labels for no stages', () => {
    expect(computeLocalityAreaSeries([], { bucketWidthMs: 1000 }).labels).toEqual([]);
  });
});
