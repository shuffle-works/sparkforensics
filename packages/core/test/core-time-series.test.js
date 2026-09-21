import { describe, it, expect } from 'vitest';
import { computeCoreTimeSeries } from '../src/core-time-series.js';

describe('computeCoreTimeSeries: coreCount bucketing', () => {
  it('histograms a single task at 1 busy core', () => {
    const r = computeCoreTimeSeries([{ launch: 0, finish: 1000 }], { bucketBy: 'coreCount' });
    expect(r.mode).toBe('coreCount');
    expect(r.histogram[1]).toBe(1000);
    expect(r.histogram.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('splits overlapping tasks across concurrency levels', () => {
    // [0,1000) and [500,1500): busy=1 on [0,500)+[1000,1500)=1000ms, busy=2 on [500,1000)=500ms
    const r = computeCoreTimeSeries(
      [{ launch: 0, finish: 1000 }, { launch: 500, finish: 1500 }],
      { bucketBy: 'coreCount' });
    expect(r.histogram[1]).toBe(1000);
    expect(r.histogram[2]).toBe(500);
    expect(r.histogram.reduce((a, b) => a + b, 0)).toBe(1500);
  });

  it('treats [launch, finish) as half-open: back-to-back tasks never overlap', () => {
    const r = computeCoreTimeSeries(
      [{ launch: 0, finish: 500 }, { launch: 500, finish: 1000 }],
      { bucketBy: 'coreCount' });
    expect(r.histogram[1]).toBe(1000);
    expect(r.histogram[2]).toBeUndefined();
  });

  it('skips zero/negative-duration intervals', () => {
    const r = computeCoreTimeSeries(
      [{ launch: 100, finish: 100 }, { launch: 200, finish: 150 }],
      { bucketBy: 'coreCount' });
    expect(r.histogram.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('returns an empty histogram for no intervals', () => {
    expect(computeCoreTimeSeries([], { bucketBy: 'coreCount' }))
      .toEqual({ mode: 'coreCount', histogram: [] });
  });
});

describe('computeCoreTimeSeries: time bucketing', () => {
  it('produces one bucket of busy-core-ms for a single task', () => {
    const r = computeCoreTimeSeries([{ launch: 0, finish: 1000 }],
      { bucketBy: 'time', bucketWidthMs: 1000 });
    expect(r.mode).toBe('time');
    expect(r.startTime).toBe(0);
    expect(r.endTime).toBe(1000);
    expect(r.buckets).toEqual([{ tStart: 0, tEnd: 1000, busyCoreMs: 1000, avgBusyCores: 1 }]);
  });

  it('integrates busy cores within each fixed-width bucket', () => {
    // [0,1000) and [500,1500), 1000ms buckets:
    //  bucket [0,1000): 500ms@1 + 500ms@2 = 1500 busyCoreMs, avg 1.5
    //  bucket [1000,2000): 500ms@1 (task 2 runs to 1500) = 500 busyCoreMs, avg 0.5
    const r = computeCoreTimeSeries(
      [{ launch: 0, finish: 1000 }, { launch: 500, finish: 1500 }],
      { bucketBy: 'time', bucketWidthMs: 1000 });
    expect(r.buckets).toEqual([
      { tStart: 0, tEnd: 1000, busyCoreMs: 1500, avgBusyCores: 1.5 },
      { tStart: 1000, tEnd: 2000, busyCoreMs: 500, avgBusyCores: 0.5 },
    ]);
  });

  it('returns no buckets for no intervals', () => {
    expect(computeCoreTimeSeries([], { bucketBy: 'time', bucketWidthMs: 1000 }))
      .toEqual({ mode: 'time', bucketWidthMs: 1000, startTime: null, endTime: null, buckets: [] });
  });
});

describe('computeCoreTimeSeries: hypothetical-N replay (clamp)', () => {
  it('clamps concurrency to N in coreCount mode', () => {
    // overlap peaks at 2; with N=1 all wall-clock counts at busy=1
    const r = computeCoreTimeSeries(
      [{ launch: 0, finish: 1000 }, { launch: 500, finish: 1500 }],
      { bucketBy: 'coreCount', hypotheticalCores: 1 });
    expect(r.histogram[1]).toBe(1500);
    expect(r.histogram[2]).toBeUndefined();
  });

  it('clamps busy-core-ms to N in time mode', () => {
    const r = computeCoreTimeSeries(
      [{ launch: 0, finish: 1000 }, { launch: 500, finish: 1500 }],
      { bucketBy: 'time', bucketWidthMs: 1000, hypotheticalCores: 1 });
    // bucket [0,1000): min(1,1)*500 + min(2,1)*500 = 1000 busyCoreMs
    expect(r.buckets[0]).toEqual({ tStart: 0, tEnd: 1000, busyCoreMs: 1000, avgBusyCores: 1 });
    expect(r.buckets[1]).toEqual({ tStart: 1000, tEnd: 2000, busyCoreMs: 500, avgBusyCores: 0.5 });
  });
});
