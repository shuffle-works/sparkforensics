import { describe, it, expect } from 'vitest';
import { analyze, auditConfig } from '../src/analyzer.js';
import { DETECTORS, detectorCatalog } from '../src/detectors.js';
import { formatBytes } from '../src/format-utils.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

// Shared fixture for tests needing no bespoke overrides.
const sampleApp = makeApp();
const sampleStages = new Map([[1, makeStage()]]);
const sampleAdded = [];
const sampleRemoved = [];
const sampleJobs = new Map([[0, makeJob(0, true)]]);

describe('analyze: task skew', () => {
  it('emits no bottleneck when ratio is below threshold', () => {
    const stages = new Map([[1, makeStage({ taskDurationP50: 100, taskDurationP95: 200 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.filter(b => b.type === 'skew')).toHaveLength(0);
  });

  it('emits a skew finding above the 3× P95/median ratio', () => {
    // Detector grades 'warning'; deriveImpactBand promotes to 'critical' (250ms delta = 5% of the 5s default, over the 2% floor).
    const stages = new Map([[1, makeStage({ taskDurationP50: 100, taskDurationP95: 350 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const skew = catalog.filter(b => b.type === 'skew');
    expect(skew).toHaveLength(1);
    expect(skew[0].impactBand).toBe('critical');
    expect(skew[0].stageId).toBe(1);
  });

  it('emits critical when P95/median > 5×', () => {
    const stages = new Map([[1, makeStage({ taskDurationP50: 100, taskDurationP95: 600 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find(b => b.type === 'skew').impactBand).toBe('critical');
  });

  it('uses max/median fallback for stages with < 20 tasks', () => {
    const stages = new Map([[1, makeStage({ taskCount: 10, taskDurationP50: 100, taskDurationP95: 100, taskDurationMax: 400 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find(b => b.type === 'skew').impactBand).toBe('critical');
  });

  it('suppresses a critical-ratio skew finding when the absolute waste is negligible against total app runtime', () => {
    // ratio 6× clears warn on paper, but 5ms p95-p50 in a 1,000,000ms app is under the runtime floor: the critical-with-sub-second-savings mismatch the floor prevents.
    const stages = new Map([[1, makeStage({ taskDurationP50: 1, taskDurationP95: 6 })]]);
    const catalog = analyze(makeApp({ startTime: 0, endTime: 1000000 }), stages, [], []);
    expect(catalog.filter(b => b.type === 'skew')).toHaveLength(0);
  });

  it('caps a skew finding at warning when the waste clears the warn floor but not the critical floor', () => {
    // ratio 7× clears warn (3×); 60ms clears the 0.5% warn floor (50ms) but not the 2% crit floor (200ms) of a 10,000ms app.
    const stages = new Map([[1, makeStage({ taskDurationP50: 10, taskDurationP95: 70 })]]);
    const catalog = analyze(makeApp({ startTime: 0, endTime: 10000 }), stages, [], []);
    expect(catalog.find(b => b.type === 'skew').impactBand).toBe('warning');
  });

  it('falls back to the fixed impactBand when total app runtime is unavailable', () => {
    // With no total duration, deriveImpactBand leaves the detector's fixed fallback ('warning') untouched regardless of ratio.
    const stages = new Map([[1, makeStage({ taskDurationP50: 1, taskDurationP95: 6 })]]);
    const catalog = analyze(makeApp({ startTime: undefined, endTime: undefined }), stages, [], []);
    expect(catalog.find(b => b.type === 'skew').impactBand).toBe('warning');
  });

  it('credits a one-task-dominated stage\'s tail as recoverable: the fix shortens the very task the ceiling used to floor it at', () => {
    // The 5,000ms max task fills nearly the whole 5,005ms window. Fixing the skew brings the tail
    // down to ~P50, so the recoverable time is the 4,990ms delta, not the 5ms left above that task.
    const stages = new Map([[1, makeStage({
      submittedAt: 0, completedAt: 5005, taskDurationP50: 10, taskDurationP95: 5000, taskDurationMax: 5000,
    })]]);
    const catalog = analyze(makeApp({ startTime: 0, endTime: 100000 }), stages, [], []);
    const skew = catalog.filter(b => b.type === 'skew');
    expect(skew).toHaveLength(1);
    expect(skew[0].impactEstimate.wallClock.high).toBe(4990);
    expect(skew[0].impactBand).toBe('critical');
  });

  it('suppresses a critical-ratio skew finding whose raw waste clears the floor but whose occupancy-clipped recoverable time does not', () => {
    // 14,990 core-ms less the 4,990ms the fix removes leaves 10,000 core-ms over 2 cores: 5,000ms of
    // unavoidable work in the 5,005ms window, so only 5ms is recoverable despite a 4,990ms raw delta
    // that clears both floors.
    const stages = new Map([[1, makeStage({
      submittedAt: 0, completedAt: 5005, taskDurationP50: 10, taskDurationP95: 5000, taskDurationMax: 5000, executorRunTime: 14990,
    })]]);
    const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 2 }];
    const catalog = analyze(makeApp({ startTime: 0, endTime: 100000 }), stages, executorsAdded, []);
    expect(catalog.filter(b => b.type === 'skew')).toHaveLength(0);
  });
});

describe('analyze: shuffle I/O', () => {
  it('emits no bottleneck below 50 MB', () => {
    const stages = new Map([[1, makeStage({ shuffleReadBytes: 40 * 1024 * 1024 })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'shuffle')).toHaveLength(0);
  });

  it('emits a shuffle finding above 50 MB, reconciled to critical against the default fixture duration', () => {
    // Detector grades 'info'; deriveImpactBand promotes to 'critical' (60 MB clears the 2% floor of the 5s default).
    // The tasks measured 500ms of fetch wait (5000 core-ms at the fixture's 10x concurrency), so the
    // 503ms link model is claimed nearly whole.
    const stages = new Map([[1, makeStage({ shuffleReadBytes: 60 * 1024 * 1024, fetchWaitTime: 5000 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'shuffle');
    expect(b.impactBand).toBe('critical');
  });

  it('emits critical above 1 GB', () => {
    const stages = new Map([[1, makeStage({ shuffleReadBytes: 2 * 1024 * 1024 * 1024, fetchWaitTime: 10000 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'shuffle');
    expect(b.impactBand).toBe('critical');
  });

  it('skips a shuffle or spill on a stage under 0.5% of the run, and keeps a longer stage\'s above info', () => {
    const run = makeApp({ endTime: 400_000 });
    const stage = (completedAt) => new Map([[1, makeStage({
      shuffleReadBytes: 2 * 1024 * 1024 * 1024, fetchWaitTime: 40_000, memoryBytesSpilled: 8 * 1024 * 1024 * 1024,
      diskBytesSpilled: 4 * 1024 * 1024 * 1024, spillMemMax: 8 * 1024 * 1024 * 1024, spillDiskMax: 4 * 1024 * 1024 * 1024, completedAt,
    })]]);
    const of = (completedAt, type) => analyze(run, stage(completedAt), [], []).filter(b => b.type === type);
    // 1s of a 400s run (0.25%): the bytes are real, the floor drops them.
    expect(of(1000, 'shuffle')).toHaveLength(0);
    expect(of(1000, 'spill')).toHaveLength(0);
    // 8s (2%): both claim enough of the run to grade above info.
    expect(of(8000, 'shuffle')[0].impactBand).not.toBe('info');
    expect(of(8000, 'spill')[0].impactBand).not.toBe('info');
    // A zero-length stage (no submission time on older Spark) isn't skipped.
    expect(of(0, 'spill')).toHaveLength(1);
  });

  it('grades a large shuffle whose tasks never waited on a fetch informational: nothing stalled', () => {
    const stages = new Map([[1, makeStage({ shuffleReadBytes: 2 * 1024 * 1024 * 1024, fetchWaitTime: 0 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'shuffle');
    expect(b.impactEstimate.wallClock.high).toBe(0);
    expect(b.impactBand).toBe('info');
  });
});

describe('analyze: slow host', () => {
  function stageWithHosts(hostStats, overrides = {}) {
    const taskCount = hostStats.reduce((s, h) => s + h.taskCount, 0);
    return makeStage({ taskCount, hostStats, ...overrides });
  }

  it('emits no slowHost when fewer than 3 hosts', () => {
    const stages = new Map([[1, stageWithHosts([
      { host: 'a', taskCount: 10, totalDuration: 1000 },
      { host: 'b', taskCount: 10, totalDuration: 5000 },
    ])]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'slowHost')).toHaveLength(0);
  });

  it('emits no slowHost when stage taskCount < 15', () => {
    const stages = new Map([[1, stageWithHosts([
      { host: 'a', taskCount: 4, totalDuration: 400 },
      { host: 'b', taskCount: 4, totalDuration: 400 },
      { host: 'c', taskCount: 4, totalDuration: 4000 },
    ])]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'slowHost')).toHaveLength(0);
  });

  it('emits a slowHost finding when a host is 2-4× the median host-mean, reconciled to critical here', () => {
    // Detector grades 'warning' at 3×; deriveImpactBand promotes to 'critical' against the 5s default.
    const stages = new Map([[1, stageWithHosts([
      { host: 'a', taskCount: 20, totalDuration: 200000 },   // mean 10000ms
      { host: 'b', taskCount: 20, totalDuration: 200000 },   // mean 10000ms
      { host: 'c', taskCount: 20, totalDuration: 600000 },   // mean 30000ms -> 3×
    ])]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'slowHost');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('critical');
    expect(b.host).toBe('c');
    expect(b.value).toBe(3);
  });

  it('emits critical slowHost when ratio >= 4×', () => {
    const stages = new Map([[1, stageWithHosts([
      { host: 'a', taskCount: 20, totalDuration: 200000 },
      { host: 'b', taskCount: 20, totalDuration: 200000 },
      { host: 'c', taskCount: 20, totalDuration: 1000000 }, // mean 50000ms -> 5×
    ])]]);
    expect(analyze(makeApp(), stages, [], []).find(b => b.type === 'slowHost').impactBand).toBe('critical');
  });

  it('skips slow host with < 20% task share', () => {
    const stages = new Map([[1, stageWithHosts([
      { host: 'a', taskCount: 40, totalDuration: 400000 },
      { host: 'b', taskCount: 40, totalDuration: 400000 },
      { host: 'c', taskCount: 3, totalDuration: 300000 },  // mean 100000ms = 10×, but only 3/83 = 3.6% share
    ])]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'slowHost')).toHaveLength(0);
  });

  it('does not flag hostMeanRatio when the absolute duration is sub-second noise (ratio 4× but ~200ms)', () => {
    // Reproduces the reported false-positive: sub-2s stage where trivial ms differences inflate the ratio.
    const stages = new Map([[1, stageWithHosts([
      { host: 'a', taskCount: 20, totalDuration: 1000 },  // mean 50ms
      { host: 'b', taskCount: 20, totalDuration: 1000 },  // mean 50ms
      { host: 'c', taskCount: 20, totalDuration: 4000 },  // mean 200ms -> 4× (would be 'critical' pre-floor)
    ])]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'slowHost' && b.metric === 'hostMeanRatio')).toHaveLength(0);
  });

  it('still flags hostMeanRatio critical for large absolute durations at the same 4× ratio (no regression)', () => {
    const stages = new Map([[1, stageWithHosts([
      { host: 'a', taskCount: 20, totalDuration: 600000 },   // mean 30000ms (30s)
      { host: 'b', taskCount: 20, totalDuration: 600000 },   // mean 30000ms (30s)
      { host: 'c', taskCount: 20, totalDuration: 2400000 },  // mean 120000ms (120s) -> 4×
    ])]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'slowHost' && b.metric === 'hostMeanRatio');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('critical');
  });

  it('flags hostMeanRatio at exactly the 1000ms absolute floor (inclusive)', () => {
    const stages = new Map([[1, stageWithHosts([
      { host: 'a', taskCount: 20, totalDuration: 5000 },     // mean 250ms
      { host: 'b', taskCount: 20, totalDuration: 5000 },     // mean 250ms
      { host: 'c', taskCount: 20, totalDuration: 20000 },    // mean 1000ms -> exactly the floor, 4× ratio
    ])]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'slowHost' && b.metric === 'hostMeanRatio');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('critical');
  });
});

describe('analyze: stage slowness fallback + suppression (§6)', () => {
  const min = 60000;
  // Wall-clock (completedAt/submittedAt) drives the band; the guard is !(stageDurationMs > 0), not executorRunTime, which here is just realistic filler.
  const slow = (mins, execs) => makeStage({ id: 1, executorRunTime: mins * min * execs, executorStats: Array.from({ length: execs }, (_, i) => ({ executorId: `e${i}`, taskCount: 1, totalDuration: 0 })), hostStats: [], submittedAt: 0, completedAt: mins * min });
  it('fires from 15 minutes of wall-clock; its band comes from the partitioning headroom, not the duration', () => {
    // 4 tasks on a 16-core cluster, running the whole window: more partitions could spread it over
    // all 16 cores (critical against the 100-minute app). With 100 tasks there's no headroom (info).
    const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 16 }];
    const app = makeApp({ startTime: 0, endTime: 100 * min });
    const run = (mins, taskCount) => analyze(app, new Map([[1, { ...slow(mins, 4), taskCount, taskActiveMs: mins * min }]]), executorsAdded, [])
      .find(b => b.type === 'stageSlowness');
    expect(run(14, 4)).toBeUndefined();
    expect(run(15, 4).impactBand).toBe('critical');
    expect(run(15, 4).impactEstimate.wallClock.high).toBeCloseTo(15 * min * (12 / 16), 6);
    expect(run(61, 100).impactBand).toBe('info');
  });
  it('is suppressed when a slowHost finding exists on the same stage', () => {
    const hostStats = [ { host: 'hot', taskCount: 40, totalDuration: 8e6 }, { host: 'b', taskCount: 5, totalDuration: 5000 }, { host: 'c', taskCount: 5, totalDuration: 5000 } ];
    const stage = makeStage({ id: 1, taskCount: 50, hostStats, executorRunTime: 70 * min * 4, executorStats: Array.from({ length: 4 }, (_, i) => ({ executorId: `e${i}`, taskCount: 1, totalDuration: 0 })), submittedAt: 0, completedAt: 70 * min }); // wall-clock basis per Decision 7
    const catalog = analyze(makeApp(), new Map([[1, stage]]), [], []);
    expect(catalog.some(b => b.type === 'slowHost')).toBe(true);
    expect(catalog.some(b => b.type === 'stageSlowness')).toBe(false);
  });

  it('scores stageSlowness off real wall-clock duration, not per-executor average (Decision 7)', () => {
    // executorRunTime aggregate is small, but the stage's real wall-clock duration is long due to low concurrency.
    const stages = new Map([
      [0, makeStage({
        id: 0,
        taskCount: 2,
        executorRunTime: 2 * 60 * 1000, // 2 minutes summed across 2 tasks
        submittedAt: 0,
        completedAt: 20 * 60 * 1000, // 20 minutes real wall-clock -> should fire
      })],
    ]);
    const findings = analyze(makeApp(), stages, [], []);
    const finding = findings.find((f) => f.type === 'stageSlowness');
    expect(finding).toBeDefined();
    expect(finding.stageId).toBe(0);
  });

  it('fires on wall-clock duration alone when executorRunTime is 0 (stage stalled before any task ran), claiming nothing', () => {
    // Guard checks stageDurationMs, not executorRunTime: a stage stalled before any task ran has
    // executorRunTime 0 but can still be slow by wall clock. No task ran, so more partitions
    // recover nothing: the finding stays at the detector's own 'info'.
    const stages = new Map([
      [0, makeStage({
        id: 0,
        executorRunTime: 0,
        taskActiveMs: 0,
        submittedAt: 0,
        completedAt: 20 * 60 * 1000, // 20 minutes real wall-clock -> should still fire
      })],
    ]);
    const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 16 }];
    const finding = analyze(makeApp(), stages, executorsAdded, []).find((f) => f.type === 'stageSlowness');
    expect(finding).toBeDefined();
    expect(finding.impactEstimate.wallClock.high).toBe(0);
    expect(finding.impactBand).toBe('info');
  });

  it('does not fire when wall-clock duration is zero, even with executorRunTime > 0', () => {
    const stages = new Map([
      [0, makeStage({
        id: 0,
        executorRunTime: 999 * 60 * 1000, // large, but not the basis
        submittedAt: 1000,
        completedAt: 1000, // zero wall-clock duration
      })],
    ]);
    expect(analyze(makeApp(), stages, [], []).some((f) => f.type === 'stageSlowness')).toBe(false);
  });
});

describe('analyze: host duration-share (§2a)', () => {
  it('flags a host owning ≥75% duration and ≥50% tasks', () => {
    const hostStats = [
      { host: 'hot', taskCount: 60, totalDuration: 90000 },
      { host: 'b', taskCount: 20, totalDuration: 5000 },
      { host: 'c', taskCount: 20, totalDuration: 5000 },
    ];
    const stages = new Map([[1, makeStage({ taskCount: 100, hostStats })]]);
    const found = analyze(makeApp(), stages, [], []).filter(b => b.type === 'slowHost' && b.variant === 'durationShare');
    expect(found).toHaveLength(1);
    expect(found[0].host).toBe('hot');
  });
  it('does not flag duration-share when task share < 50%', () => {
    const hostStats = [
      { host: 'hot', taskCount: 40, totalDuration: 90000 },
      { host: 'b', taskCount: 30, totalDuration: 5000 },
      { host: 'c', taskCount: 30, totalDuration: 5000 },
    ];
    const stages = new Map([[1, makeStage({ taskCount: 100, hostStats })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.variant === 'durationShare')).toHaveLength(0);
  });
});

describe('analyze: executor multi-dim imbalance (§2b)', () => {
  const base = { taskCount: 5, totalDuration: 5000, inputBytes: 500, shuffleReadBytes: 0, shuffleWriteBytes: 0 };
  it('flags task-time deviation past the top tier as critical', () => {
    const executorStats = [
      { executorId: 'e1', ...base, taskCount: 5, totalDuration: 500000 }, // mean 100000
      { executorId: 'e2', ...base }, // mean 1000
      { executorId: 'e3', ...base }, // mean 1000  → max/median = 100×
    ];
    const stages = new Map([[1, makeStage({ taskCount: 15, executorStats, hostStats: [] })]]);
    const f = analyze(makeApp(), stages, [], []).filter(b => b.variant === 'multiDim' && b.dimension === 'taskTime');
    expect(f).toHaveLength(1);
    expect(f[0].impactBand).toBe('critical');
    expect(f[0].executorId).toBe('e1');
  });
  it('skips the storage-memory dimension when executorMetrics is empty (no crash)', () => {
    const executorStats = [
      { executorId: 'e1', ...base }, { executorId: 'e2', ...base }, { executorId: 'e3', ...base },
    ];
    const stages = new Map([[1, makeStage({ taskCount: 15, executorStats, executorMetrics: new Map() })]]);
    expect(() => analyze(makeApp(), stages, [], [])).not.toThrow();
    expect(analyze(makeApp(), stages, [], []).filter(b => b.dimension === 'storageMemory')).toHaveLength(0);
  });

  it('does not flag taskTime when absolute per-task time is sub-second noise (10× ratio, ~200ms)', () => {
    const executorStats = [
      { executorId: 'e1', ...base, taskCount: 5, totalDuration: 1000 }, // mean 200ms
      { executorId: 'e2', ...base, taskCount: 5, totalDuration: 100 },  // mean 20ms
      { executorId: 'e3', ...base, taskCount: 5, totalDuration: 100 },  // mean 20ms -> max/median = 10×
    ];
    const stages = new Map([[1, makeStage({ taskCount: 15, executorStats, hostStats: [] })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.variant === 'multiDim' && b.dimension === 'taskTime')).toHaveLength(0);
  });

  it('does not flag inputBytes when the absolute byte volume is tiny (10× ratio, 100 bytes)', () => {
    const executorStats = [
      { executorId: 'e1', ...base, inputBytes: 100 },
      { executorId: 'e2', ...base, inputBytes: 10 },
      { executorId: 'e3', ...base, inputBytes: 10 }, // max/median = 10×
    ];
    const stages = new Map([[1, makeStage({ taskCount: 15, executorStats, hostStats: [] })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.variant === 'multiDim' && b.dimension === 'inputBytes')).toHaveLength(0);
  });

  it('still flags inputBytes at the same 10× ratio when volumes are large (no regression)', () => {
    const executorStats = [
      { executorId: 'e1', ...base, inputBytes: 200 * 1024 * 1024 },
      { executorId: 'e2', ...base, inputBytes: 20 * 1024 * 1024 },
      { executorId: 'e3', ...base, inputBytes: 20 * 1024 * 1024 }, // max/median = 10×
    ];
    const stages = new Map([[1, makeStage({ taskCount: 15, executorStats, hostStats: [] })]]);
    const f = analyze(makeApp(), stages, [], []).filter(b => b.variant === 'multiDim' && b.dimension === 'inputBytes');
    expect(f).toHaveLength(1);
    expect(f[0].impactBand).toBe('critical');
  });

  // Byte imbalance carries no time estimate, so its ratio tier is its band. A stage too short
  // (under 0.5% of the run) to cost that much is skipped, since everything there graded info.
  it('skips a slow host on a stage under 0.5% of the run, and keeps its tier on a longer one', () => {
    const executorStats = [
      { executorId: 'e1', ...base, inputBytes: 200 * 1024 * 1024 },
      { executorId: 'e2', ...base, inputBytes: 20 * 1024 * 1024 },
      { executorId: 'e3', ...base, inputBytes: 20 * 1024 * 1024 },
    ];
    const longRun = makeApp({ startTime: 0, endTime: 400_000 });
    const at = (completedAt) => analyze(longRun, new Map([[1, makeStage({ taskCount: 15, executorStats, hostStats: [], submittedAt: 0, completedAt })]]), [], [])
      .filter(b => b.type === 'slowHost');
    expect(at(1000)).toHaveLength(0); // 0.25% of the run: the imbalance is real, the floor drops it
    const kept = at(4000).filter(b => b.variant === 'multiDim' && b.dimension === 'inputBytes'); // 1%
    expect(kept).toHaveLength(1);
    expect(kept[0].impactBand).not.toBe('info');
  });
});

describe('analyze: failed task rate', () => {
  it('emits no failures bottleneck when failureRate <= 5%', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, failedTasks: 5 })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'failures')).toHaveLength(0);
  });

  it('emits warning when 5% < failureRate <= 20%', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, failedTasks: 10 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'failures');
    expect(b.impactBand).toBe('warning');
    expect(b.value).toBe(10);
  });

  it('emits critical when failureRate > 20%', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, failedTasks: 25 })]]);
    expect(analyze(makeApp(), stages, [], []).find(b => b.type === 'failures').impactBand).toBe('critical');
  });

  it('skips stages with fewer than 10 tasks', () => {
    const stages = new Map([[1, makeStage({ taskCount: 9, failedTasks: 5 })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'failures')).toHaveLength(0);
  });

  it('picks dominant failure reason from failureReasons array', () => {
    const stages = new Map([[1, makeStage({
      taskCount: 100, failedTasks: 10,
      failureReasons: [
        { reason: 'FetchFailed', count: 7 },
        { reason: 'ExecutorLostFailure', count: 3 },
      ],
    })]]);
    expect(analyze(makeApp(), stages, [], []).find(b => b.type === 'failures').dominantReason).toBe('FetchFailed');
  });

  it('dominantReason is null when failureReasons is empty', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, failedTasks: 10 })]]);
    expect(analyze(makeApp(), stages, [], []).find(b => b.type === 'failures').dominantReason).toBeNull();
  });
});

describe('analyze: speculative / straggler', () => {
  it('emits no straggler when no speculative tasks and straggler share <= 5%', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, speculativeTasks: 0, stragglerCount: 4 })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'straggler')).toHaveLength(0);
  });

  it('admits a 2.5-5% straggler share only when its recoverable tail clears the runtime floor', () => {
    // 4/100 = 4% stragglers. A 4,900ms tail on a 5,000ms stage in a 500,000ms app clears the 0.5%
    // floor (2,500ms); a 400ms tail does not.
    const app = makeApp({ startTime: 0, endTime: 500000 });
    const stage = (max) => new Map([[1, makeStage({
      taskCount: 100, speculativeTasks: 0, stragglerCount: 4, completedAt: 5000, taskDurationP50: 100, taskDurationMax: max,
    })]]);
    const gating = analyze(app, stage(5000), [], []).find(b => b.type === 'straggler');
    expect(gating.metric).toBe('stragglerShare');
    expect(gating.impactBand).toBe('warning');
    expect(gating.confidence).toBe('low');
    expect(analyze(app, stage(500), [], []).find(b => b.type === 'straggler')).toBeUndefined();
    // At or under 2.5% nothing fires, however long the tail.
    const two = new Map([[1, makeStage({ taskCount: 100, stragglerCount: 2, completedAt: 5000, taskDurationP50: 100, taskDurationMax: 5000 })]]);
    expect(analyze(app, two, [], []).find(b => b.type === 'straggler')).toBeUndefined();
    // No app end time (an incomplete run): the floor can't be checked, so the lower gate stays shut.
    expect(analyze(makeApp({ startTime: 0, endTime: null }), stage(5000), [], []).find(b => b.type === 'straggler')).toBeUndefined();
  });

  it('skips stages with fewer than 10 tasks', () => {
    const stages = new Map([[1, makeStage({ taskCount: 8, speculativeTasks: 3, stragglerCount: 0 })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'straggler')).toHaveLength(0);
  });

  it('emits straggler when any speculative task present', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, speculativeTasks: 2, stragglerCount: 0 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'straggler');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('info');
    expect(b.metric).toBe('speculativeTasks');
    expect(b.value).toBe(2);
  });

  it('emits straggler when stragglerCount > 5% of tasks', () => {
    // taskDurationMax raised above p50 so the runtime floor sees real waste, not the fixture's zero-variance durations.
    const stages = new Map([[1, makeStage({ taskCount: 100, speculativeTasks: 0, stragglerCount: 8, taskDurationMax: 300 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'straggler');
    expect(b).toBeTruthy();
    expect(b.metric).toBe('stragglerShare');
    expect(b.value).toBe(8);
    expect(b.impactBand).toBe('critical');
  });

  it('flags a large straggler share even with zero speculative tasks, reconciled to critical here', () => {
    // Detector grades 'warning'; deriveImpactBand promotes to 'critical' against the default fixture duration.
    const stages = new Map([[1, makeStage({ taskCount: 100, speculativeTasks: 0, stragglerCount: 44, taskDurationMax: 300 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'straggler');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('critical');
  });

  it('reports stragglerShare, not a misleadingly-low speculativeTasks count, when the straggler share is what actually drove the impact band', () => {
    // 50% straggler share ('warning') beats 1% speculative ('info'); metric/value must reflect the criterion that drove the grade, not just that speculation was on.
    const stages = new Map([[1, makeStage({ taskCount: 100, speculativeTasks: 1, stragglerCount: 50, taskDurationMax: 300 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'straggler');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('critical');
    expect(b.metric).toBe('stragglerShare');
    expect(b.value).toBe(50);
  });

  it('caps a large straggler share at info when task durations show no real variance', () => {
    // taskDurationMax == taskDurationP50 means zero modeled waste, so the share-driven label caps at info.
    const stages = new Map([[1, makeStage({ taskCount: 100, speculativeTasks: 0, stragglerCount: 44 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'straggler');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('info');
  });

  it('caps a large straggler share at info when the raw waste clears the floor but the occupancy-clipped recoverable time does not', () => {
    // Like the skew ceiling test: the 10,000 core-ms left after the fix removes 4,990 fill the
    // 5,005ms window over 2 cores, so only 5ms is recoverable despite a raw delta that clears the
    // 25ms warn floor.
    const stages = new Map([[1, makeStage({
      taskCount: 100, speculativeTasks: 0, stragglerCount: 50,
      submittedAt: 0, completedAt: 5005, taskDurationP50: 10, taskDurationMax: 5000, executorRunTime: 14990,
    })]]);
    const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 2 }];
    const b = analyze(makeApp(), stages, executorsAdded, []).find(b => b.type === 'straggler');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('info');
  });

  it('grades a straggler that alone gates its stage on the recoverable tail, not on ~0', () => {
    // Same 5,000ms straggler in a 5,005ms window, but no core work filling it: bringing the
    // straggler down to P50 recovers the 4,990ms delta.
    const stages = new Map([[1, makeStage({
      taskCount: 100, speculativeTasks: 0, stragglerCount: 50,
      submittedAt: 0, completedAt: 5005, taskDurationP50: 10, taskDurationMax: 5000,
    })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'straggler');
    expect(b.impactEstimate.wallClock.high).toBe(4990);
    expect(b.impactBand).toBe('critical');
  });

  it('skips a stage shorter than 0.5% of the run, whose tail could only grade info, and keeps a warning one', () => {
    const straggling = { taskCount: 100, speculativeTasks: 3, stragglerCount: 50, taskDurationP50: 10, taskDurationMax: 400 };
    // A 1s stage in a 400s run (0.25%): the tail is real, but can't cost 0.5% of the run.
    const short = new Map([[1, makeStage({ ...straggling, submittedAt: 0, completedAt: 1000 })]]);
    expect(analyze(makeApp({ endTime: 400_000 }), short, [], []).filter(b => b.type === 'straggler')).toHaveLength(0);
    // The same run without an end (duration unknown) keeps it, as the other runtime floors do.
    expect(analyze(makeApp({ endTime: null }), short, [], []).filter(b => b.type === 'straggler')).toHaveLength(1);
    // A 5s stage (1.25%) whose 4.99s tail clears the floor still grades above info.
    const long = new Map([[1, makeStage({ ...straggling, submittedAt: 0, completedAt: 5005, taskDurationMax: 5000 })]]);
    const b = analyze(makeApp({ endTime: 400_000 }), long, [], []).find(b => b.type === 'straggler');
    expect(b.impactBand).toBe('warning');
  });
});

describe('analyze: skew/straggler same-stage overlap disclosure (§4)', () => {
  it('flags both findings when skew (max/median branch) and straggler fire on the same stage', () => {
    // taskCount below minTasksForP95 (20): skew uses its max/median branch, driven by the exact
    // same (taskDurationMax - taskDurationP50) delta straggler's own wallClock estimate uses.
    const stages = new Map([[1, makeStage({
      taskCount: 15, taskDurationP50: 100, taskDurationMax: 900,
      speculativeTasks: 0, stragglerCount: 2,
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const skew = catalog.find(b => b.type === 'skew');
    const straggler = catalog.find(b => b.type === 'straggler');
    expect(skew).toBeTruthy();
    expect(skew.metric).toBe('max/median');
    expect(straggler).toBeTruthy();
    expect(skew.validationRequired).toMatch(/overlaps with the straggler finding/);
    expect(straggler.validationRequired).toMatch(/overlaps with the skew finding/);
  });

  it('does not flag an overlap when skew uses its P95/median branch (a different task, not the same delta)', () => {
    const stages = new Map([[1, makeStage({
      taskCount: 25, taskDurationP50: 100, taskDurationP95: 600, taskDurationMax: 900,
      speculativeTasks: 0, stragglerCount: 2,
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const skew = catalog.find(b => b.type === 'skew');
    const straggler = catalog.find(b => b.type === 'straggler');
    expect(skew).toBeTruthy();
    expect(skew.metric).toBe('P95/median');
    expect(straggler).toBeTruthy();
    expect(skew.validationRequired ?? '').not.toMatch(/overlaps with/);
    expect(straggler.validationRequired ?? '').not.toMatch(/overlaps with/);
  });

  it('does not flag skew when no straggler fires on the same stage', () => {
    const stages = new Map([[1, makeStage({
      taskCount: 15, taskDurationP50: 100, taskDurationMax: 900,
      speculativeTasks: 0, stragglerCount: 0,
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const skew = catalog.find(b => b.type === 'skew');
    expect(skew).toBeTruthy();
    expect(catalog.find(b => b.type === 'straggler')).toBeUndefined();
    expect(skew.validationRequired ?? '').not.toMatch(/overlaps with/);
  });
});

describe('analyze: speculative tiering (§1), collapsed to critical by reconciliation', () => {
  // taskDurationMax raised above p50 so the runtime floor doesn't cap tiering at info.
  // The detector tiers by share (info 5% / warning 12% / critical 25%), but all three clear the 2% floor of the 5s default and collapse to critical here.
  const spec = (n, total) => makeStage({ taskCount: total, speculativeTasks: n, stragglerCount: 0, taskDurationMax: 300 });
  it('reconciles to critical at 5% speculative share', () => {
    const b = analyze(makeApp(), new Map([[1, spec(5, 100)]]), [], []).find(b => b.type === 'straggler');
    expect(b.impactBand).toBe('critical');
  });
  it('reconciles to critical at 12% speculative share', () => {
    const b = analyze(makeApp(), new Map([[1, spec(12, 100)]]), [], []).find(b => b.type === 'straggler');
    expect(b.impactBand).toBe('critical');
  });
  it("reconciles to critical at 25% speculative share (also the detector's own tier here)", () => {
    const b = analyze(makeApp(), new Map([[1, spec(25, 100)]]), [], []).find(b => b.type === 'straggler');
    expect(b.impactBand).toBe('critical');
  });
});

describe('analyze: partition sizing (§4)', () => {
  const MiB = 1024 * 1024;
  it('flags shuffle partition skew (max > 5× median AND > 256MiB)', () => {
    const stages = new Map([[1, makeStage({ shuffleReadP50: 10 * MiB, shuffleReadMax: 300 * MiB, shuffleReadBytes: 400 * MiB, taskCount: 50 })]]);
    const f = analyze(makeApp(), stages, [], []).filter(b => b.type === 'partitionSizing' && b.rule === 'shufflePartitionSkew');
    expect(f).toHaveLength(1);
    expect(f[0].impactBand).toBe('critical');
  });
  it('flags low shuffle parallelism (≥1GiB over ≤7 tasks)', () => {
    const stages = new Map([[1, makeStage({ shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0 })]]);
    const f = analyze(makeApp(), stages, [], []).filter(b => b.rule === 'lowShuffleParallelism');
    expect(f).toHaveLength(1);
  });
  it('flags a single partition ≥5GB as critical, alongside skew', () => {
    const stages = new Map([[1, makeStage({ shuffleReadP50: 10 * MiB, shuffleReadMax: 6 * 1024 * MiB, shuffleReadBytes: 7 * 1024 * MiB, taskCount: 50 })]]);
    const f = analyze(makeApp(), stages, [], []).filter(b => b.type === 'partitionSizing');
    expect(f.map(x => x.rule).sort()).toEqual(['maxPartitionTooBig', 'shufflePartitionSkew']);
    expect(f.find(x => x.rule === 'maxPartitionTooBig').impactBand).toBe('critical');
  });

  it('maxPartitionTooBig (regression): stays critical on a long-running job even though its own modeled time savings are a tiny fraction of total runtime', () => {
    // Audit repro: a 2-hour app with one 10-second stage carrying a 6GB single shuffle partition,
    // everything else nominal. The modeled wall-clock savings (~10s) are a tiny fraction of the
    // 2-hour run, which would demote a normal wallClock-bearing finding to 'info' via
    // deriveImpactBand's time-fraction grading; this finding is an OOM/crash-risk safety signal
    // and must not be silently downgraded just because fixing it doesn't save much time.
    const app = makeApp({ startTime: 0, endTime: 2 * 60 * 60 * 1000 });
    const stages = new Map([[1, makeStage({
      id: 1, submittedAt: 0, completedAt: 10000,
      shuffleReadP50: 1 * MiB, shuffleReadMax: 6 * 1024 * MiB, shuffleReadBytes: 6 * 1024 * MiB,
      taskCount: 50,
    })]]);
    const catalog = analyze(app, stages, [], []);
    const finding = catalog.find(b => b.type === 'partitionSizing' && b.rule === 'maxPartitionTooBig');
    expect(finding).toBeTruthy();
    expect(finding.impactBand).toBe('critical');
  });
});

describe('analyze: stage shape smells (§7)', () => {
  const execs = (n) => Array.from({ length: n }, (_, i) => ({ executorId: `e${i}`, taskCount: 1, totalDuration: 0 }));
  it('flags under-parallelization (PRatio < 0.5)', () => {
    const app = makeApp({ resources: { executor: { cores: 4 } } });
    const stage = makeStage({ taskCount: 3, executorStats: execs(4) }); // 3 / (4*4)=0.19
    const f = analyze(app, new Map([[1, stage]]), [], []).filter(b => b.rule === 'lowParallelism');
    expect(f).toHaveLength(1);
    expect(f[0].impactBand).toBe('info');
  });
  // Parallelizing a stage saves at most its own duration, so one under the 0.5% runtime floor is
  // skipped; with no known app duration the floor passes, as for the tiered detectors.
  it('skips under-parallelization on a stage shorter than 0.5% of the run', () => {
    const stage = makeStage({ taskCount: 3, executorStats: execs(4), submittedAt: 0, completedAt: 1000 }); // 1s
    const longRun = makeApp({ resources: { executor: { cores: 4 } }, startTime: 0, endTime: 400_000 }); // 1s = 0.25%
    expect(analyze(longRun, new Map([[1, stage]]), [], []).filter(b => b.rule === 'lowParallelism')).toHaveLength(0);
    const shortRun = makeApp({ resources: { executor: { cores: 4 } }, startTime: 0, endTime: 200_000 }); // 1s = 0.5%
    expect(analyze(shortRun, new Map([[1, stage]]), [], []).filter(b => b.rule === 'lowParallelism')).toHaveLength(1);
    const unknownRun = makeApp({ resources: { executor: { cores: 4 } }, endTime: null });
    expect(analyze(unknownRun, new Map([[1, stage]]), [], []).filter(b => b.rule === 'lowParallelism')).toHaveLength(1);
  });
  it('pluralizes "task" correctly for a single-task stage', () => {
    const app = makeApp({ resources: { executor: { cores: 4 } } });
    const stage = makeStage({ taskCount: 1, executorStats: execs(4) });
    const f = analyze(app, new Map([[1, stage]]), [], []).filter(b => b.rule === 'lowParallelism');
    expect(f).toHaveLength(1);
    expect(f[0].recommendation).toContain('1 task ');
    expect(f[0].recommendation).not.toContain('1 tasks');
  });
  it('flags data explosion (OIRatio > 10) but skips when inputBytes is 0', () => {
    const app = makeApp();
    const boom = makeStage({ id: 1, inputBytes: 100, outputBytes: 2000, executorStats: execs(2) });
    const zero = makeStage({ id: 2, inputBytes: 0, outputBytes: 2000, executorStats: execs(2) });
    const cat = analyze(app, new Map([[1, boom], [2, zero]]), [], []);
    const f = cat.filter(b => b.rule === 'dataExplosion');
    expect(f).toHaveLength(1);
    expect(f[0].stageId).toBe(1);
  });
  it('flags taskStageSkew (always info, no floor gate) and skips near-zero stage duration', () => {
    const app = makeApp();
    const s = makeStage({ id: 1, submittedAt: 0, completedAt: 1000, taskDurationMax: 4000, executorStats: execs(2) }); // 4×
    const f = analyze(app, new Map([[1, s]]), [], []).filter(b => b.rule === 'taskStageSkew');
    expect(f).toHaveLength(1);
    expect(f[0].impactBand).toBe('info');
  });
  it('flags taskStageSkew as info even far past the old skewCrit (5×) tier', () => {
    const app = makeApp();
    const s = makeStage({ id: 1, submittedAt: 0, completedAt: 1000, taskDurationMax: 9000, executorStats: execs(2) }); // 9×
    const f = analyze(app, new Map([[1, s]]), [], []).filter(b => b.rule === 'taskStageSkew');
    expect(f).toHaveLength(1);
    expect(f[0].impactBand).toBe('info');
  });
});

describe('analyze: caching opportunity (relation reuse)', () => {
  const MiB = 1024 * 1024;
  const parquetScan = (relation, bytes) => ({
    name: 'Scan parquet',
    detail: `FileScan parquet [c#1] Format: Parquet, Location: InMemoryFileIndex(1 paths)[hdfs://cluster/wh/${relation}], PushedFilters: []`,
    metrics: [{ name: 'size of files read', value: bytes }],
    children: [],
  });
  // A catalog-named Delta FileScan; identity comes from the untruncated nodeName.
  const deltaScan = (relation, bytes) => ({
    name: `Scan parquet spark_catalog.${relation}`,
    detail: `FileScan parquet spark_catalog.${relation}[c#1] Location: PreparedDeltaFileIndex[hdfs://cluster/wh/${relation.replace(/\./g, '/')}]`,
    metrics: [{ name: 'size of files read', value: bytes }],
    children: [],
  });
  const exec = (id, ...scanNodes) => [id, { id, planTree: { name: 'Root', detail: '', metrics: [], children: scanNodes } }];
  const caching = (sql) => analyze(makeApp(), new Map(), [], [], new Map(), sql).filter(b => b.type === 'cachingOpportunity');

  it('flags one relation scanned by two executions, summing read bytes over distinct execs', () => {
    const sql = new Map([exec(1, parquetScan('precios', 100)), exec(2, parquetScan('precios', 250))]);
    const f = caching(sql);
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe(2);
    expect(f[0].relation).toBe('precios');
    expect(f[0].format).toBe('parquet');
    expect(f[0].totalReadBytes).toBe(350);
    expect(f[0].executionIds).toEqual([1, 2]);
    expect(f[0].impactBand).toBe('info');
    // Exactly at minExecutions (2): the weakest reuse signal this detector can report.
    expect(f[0].confidence).toBe('low');
  });
  it('marks relation-reuse confidence medium at 3 executions, high at 6+ (3x minExecutions)', () => {
    const three = new Map([exec(1, parquetScan('precios', 100)), exec(2, parquetScan('precios', 100)), exec(3, parquetScan('precios', 100))]);
    expect(caching(three)[0].confidence).toBe('medium');

    const six = new Map(Array.from({ length: 6 }, (_, i) => exec(i + 1, parquetScan('precios', 100))));
    expect(caching(six)[0].confidence).toBe('high');
  });
  it('does not flag when two executions scan different relations', () => {
    const sql = new Map([exec(1, parquetScan('precios', 100)), exec(2, parquetScan('ventas', 100))]);
    expect(caching(sql)).toHaveLength(0);
  });
  it('does not flag a relation scanned twice within a single execution (self-join dedupe)', () => {
    const sql = new Map([exec(1, parquetScan('precios', 100), parquetScan('precios', 100))]);
    expect(caching(sql)).toHaveLength(0);
  });
  it('returns no caching findings for an empty ctx.sql', () => {
    expect(caching(new Map())).toHaveLength(0);
  });
  it('recommends cache/persist when total read is large (≥128 MiB)', () => {
    const sql = new Map([exec(1, parquetScan('precios', 100 * MiB)), exec(2, parquetScan('precios', 100 * MiB))]);
    const recommendation = caching(sql)[0].recommendation;
    expect(recommendation).toMatch(/Cache\/persist the shared DataFrame/);
    expect(recommendation).not.toMatch(/—/);
  });
  it('recommends broadcast for a small shared lookup', () => {
    const sql = new Map([exec(1, parquetScan('precios', 100)), exec(2, parquetScan('precios', 100))]);
    const recommendation = caching(sql)[0].recommendation;
    expect(recommendation).toMatch(/broadcast it if it is a small join lookup/);
    expect(recommendation).not.toMatch(/—/);
  });
  it('DC1: two execs scanning the SAME named Delta table → one finding (format delta)', () => {
    const sql = new Map([exec(1, deltaScan('mx.tableA', 100)), exec(2, deltaScan('mx.tableA', 250))]);
    const f = caching(sql);
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe(2);
    expect(f[0].format).toBe('delta');
    expect(f[0].relation).toBe('mx.tableA');
  });
  it('DC1: two execs scanning DIFFERENT named Delta tables → two findings (no _delta_log merge)', () => {
    const sql = new Map([exec(1, deltaScan('mx.tableA', 100), deltaScan('mx.tableB', 100)),
                         exec(2, deltaScan('mx.tableA', 100), deltaScan('mx.tableB', 100))]);
    const f = caching(sql);
    expect(f).toHaveLength(2);
    expect(f.map(x => x.relation).sort()).toEqual(['mx.tableA', 'mx.tableB']);
  });

  // A join node over two scan subtrees; condition drives structural identity via normalizeDetail.
  const joinNode = (condition, left, right) => ({
    name: 'SortMergeJoin',
    detail: `[id#1], [id#2], Inner${condition ? `, ${condition}` : ''}`,
    metrics: [],
    children: [left, right],
  });

  const unionNode = (left, right) => ({
    name: 'Union', detail: '', metrics: [], children: [left, right],
  });

  it('composite: identical Join(A,B) structure reused across two executions -> one composite finding', () => {
    const sql = new Map([
      exec(1, joinNode('', deltaScan('mx.a', 100), deltaScan('mx.b', 200))),
      exec(2, joinNode('', deltaScan('mx.a', 150), deltaScan('mx.b', 250))),
    ]);
    const findings = caching(sql);
    const composites = findings.filter(f => f.variant === 'composite');
    expect(composites).toHaveLength(1);
    expect(composites[0].value).toBe(2);
    expect(composites[0].operator).toBe('join');
    expect(composites[0].relation).toBe('mx.a join mx.b');
    // Exactly at minExecutions (2): the weakest reuse signal this detector can report.
    expect(composites[0].confidence).toBe('low');
  });

  it('composite: confidence rises to high once the same join shape repeats across 6+ executions (3x minExecutions)', () => {
    const sql = new Map(Array.from({ length: 6 }, (_, i) =>
      exec(i + 1, joinNode('', deltaScan('mx.a', 100), deltaScan('mx.b', 200)))));
    const composites = caching(sql).filter(f => f.variant === 'composite');
    expect(composites).toHaveLength(1);
    expect(composites[0].value).toBe(6);
    expect(composites[0].confidence).toBe('high');
  });

  it('composite: same tables joined with a DIFFERENT join condition -> no composite finding (structural mismatch); A/B still counted as separate leaf reuse', () => {
    const sql = new Map([
      exec(1, joinNode("(status#3 = 'active')", deltaScan('mx.a', 100), deltaScan('mx.b', 200))),
      exec(2, joinNode("(status#3 = 'inactive')", deltaScan('mx.a', 150), deltaScan('mx.b', 250))),
    ]);
    const findings = caching(sql);
    const composites = findings.filter(f => f.variant === 'composite');
    const leaves = findings.filter(f => f.variant !== 'composite');
    expect(composites).toHaveLength(0);
    expect(leaves).toHaveLength(2);
    expect(leaves.map(l => l.relation).sort()).toEqual(['mx.a', 'mx.b']);
  });

  it('composite: 3-way join where inner 2-way composite is subsumed by outer over the identical execution set -> only outer composite, inner suppressed', () => {
    const inner = () => joinNode('', deltaScan('mx.a', 10), deltaScan('mx.b', 10));
    const outer1 = joinNode('', inner(), deltaScan('mx.c', 10));
    const outer2 = joinNode('', inner(), deltaScan('mx.c', 10));
    const sql = new Map([exec(1, outer1), exec(2, outer2)]);
    const findings = caching(sql);
    const composites = findings.filter(f => f.variant === 'composite');
    expect(composites).toHaveLength(1);
    expect(composites[0].relation).toBe('mx.a join mx.b join mx.c');
  });

  it('composite: 3-way join where inner composite recurs beyond outer\'s execution set (superset) -> outer composite plus residual inner composite', () => {
    const inner = () => joinNode('', deltaScan('mx.a', 10), deltaScan('mx.b', 10));
    const outer1 = joinNode('', inner(), deltaScan('mx.c', 10));
    const outer2 = joinNode('', inner(), deltaScan('mx.c', 10));
    const sql = new Map([exec(1, outer1), exec(2, outer2), exec(3, inner()), exec(4, inner())]);
    const findings = caching(sql);
    const composites = findings.filter(f => f.variant === 'composite');
    expect(composites).toHaveLength(2);
    const outer = composites.find(c => c.relation === 'mx.a join mx.b join mx.c');
    const residualInner = composites.find(c => c.relation === 'mx.a join mx.b');
    expect(outer).toBeDefined();
    expect(outer.value).toBe(2);
    expect(residualInner).toBeDefined();
    expect(residualInner.value).toBe(2); // execs 3 and 4 only, exec 1/2's inner occurrences excluded
  });

  it('composite: inner composite nested under TWO different qualifying outer composites -> both outers emitted, no spurious residual for the inner', () => {
    const inner = () => joinNode('', deltaScan('mx.a', 10), deltaScan('mx.b', 10));
    const outerC1 = joinNode('', inner(), deltaScan('mx.c', 10));
    const outerC2 = joinNode('', inner(), deltaScan('mx.c', 10));
    const outerD1 = joinNode('', inner(), deltaScan('mx.d', 10));
    const outerD2 = joinNode('', inner(), deltaScan('mx.d', 10));
    const sql = new Map([exec(1, outerC1), exec(2, outerC2), exec(3, outerD1), exec(4, outerD2)]);
    const findings = caching(sql);
    const composites = findings.filter(f => f.variant === 'composite');
    expect(composites.map(c => c.relation).sort()).toEqual([
      'mx.a join mx.b join mx.c',
      'mx.a join mx.b join mx.d',
    ]);
  });

  it('composite: recommendation copy uses join/union wording and size-aware split', () => {
    const smallSql = new Map([
      exec(1, joinNode('', deltaScan('mx.a', 10), deltaScan('mx.b', 10))),
      exec(2, joinNode('', deltaScan('mx.a', 10), deltaScan('mx.b', 10))),
    ]);
    const [smallComposite] = caching(smallSql).filter(f => f.variant === 'composite');
    expect(smallComposite.recommendation).toMatch(/joined DataFrame/);
    expect(smallComposite.recommendation).not.toMatch(/mx\.a/); // relation identity belongs to the Relation column, not repeated here
    expect(smallComposite.recommendation).not.toMatch(/~/);
    expect(smallComposite.recommendation).not.toMatch(/—/);

    const MiB = 1024 * 1024;
    const bigSql = new Map([
      exec(1, joinNode('', deltaScan('mx.a', 100 * MiB), deltaScan('mx.b', 100 * MiB))),
      exec(2, joinNode('', deltaScan('mx.a', 100 * MiB), deltaScan('mx.b', 100 * MiB))),
    ]);
    const [bigComposite] = caching(bigSql).filter(f => f.variant === 'composite');
    expect(bigComposite.recommendation).toMatch(/joined DataFrame/);
    expect(bigComposite.recommendation).toMatch(/~/);

    const unionSql = new Map([
      exec(1, unionNode(deltaScan('mx.a', 10), deltaScan('mx.b', 10))),
      exec(2, unionNode(deltaScan('mx.a', 10), deltaScan('mx.b', 10))),
    ]);
    const [unionComposite] = caching(unionSql).filter(f => f.variant === 'composite');
    expect(unionComposite.operator).toBe('union');
    expect(unionComposite.recommendation).toMatch(/unioned DataFrame/);
    expect(unionComposite.recommendation).not.toMatch(/mx\.a/);
  });

  it('composite: full coverage (relation reused ONLY inside the composite) -> both leaf findings fully suppressed', () => {
    const sql = new Map([
      exec(1, joinNode('', deltaScan('mx.a', 100), deltaScan('mx.b', 200))),
      exec(2, joinNode('', deltaScan('mx.a', 150), deltaScan('mx.b', 250))),
    ]);
    const findings = caching(sql);
    const composites = findings.filter(f => f.variant === 'composite');
    const leaves = findings.filter(f => f.variant !== 'composite');
    expect(composites).toHaveLength(1);
    expect(leaves).toHaveLength(0);
  });

  it('composite: partial coverage (relation reused by a qualifying composite plus additional standalone executions) -> residual leaf finding for the uncovered executions only', () => {
    const sql = new Map([
      exec(1, joinNode('', deltaScan('mx.a', 100), deltaScan('mx.b', 100))),
      exec(2, joinNode('', deltaScan('mx.a', 100), deltaScan('mx.b', 100))),
      exec(3, deltaScan('mx.a', 300)), // mx.a alone, standalone reuse beyond the composite
      exec(4, deltaScan('mx.a', 300)),
    ]);
    const findings = caching(sql);
    const composite = findings.find(f => f.variant === 'composite');
    const leafA = findings.find(f => f.variant !== 'composite' && f.relation === 'mx.a');
    const leafB = findings.find(f => f.variant !== 'composite' && f.relation === 'mx.b');
    expect(composite).toBeDefined();
    expect(leafB).toBeUndefined(); // mx.b fully covered by the composite, no extra reads
    expect(leafA).toBeDefined();
    expect(leafA.executionIds).toEqual([3, 4]); // residual only: execs 1/2 covered by the composite
    expect(leafA.totalReadBytes).toBe(600);
  });

  // A scan node matching none of scanRelationId's patterns (returns null), used to build a join whose leaves are all unrecognized.
  const unrecognizedScan = (bytes) => ({
    name: 'Scan ExistingRDD',
    detail: 'ExistingRDD[c#1]',
    metrics: [{ name: 'size of files read', value: bytes }],
    children: [],
  });

  it('composite: join whose leaves are ALL unrecognized-format scans -> zero composite findings, not a blank-relation one', () => {
    const sql = new Map([
      exec(1, joinNode('', unrecognizedScan(100), unrecognizedScan(200))),
      exec(2, joinNode('', unrecognizedScan(150), unrecognizedScan(250))),
    ]);
    const findings = caching(sql);
    const composites = findings.filter(f => f.variant === 'composite');
    expect(composites).toHaveLength(0);
  });
});

describe('analyze: stage failed outright (§3)', () => {
  it('fires critical when stageFailureReason is present', () => {
    const stages = new Map([[1, makeStage({ stageFailureReason: 'Job aborted due to stage failure', failedTasks: 0 })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'stageFailed');
    expect(b.impactBand).toBe('critical');
    expect(b.stageId).toBe(1);
  });
  it('does not fire when stageFailureReason is null, even with high task failure rate', () => {
    const stages = new Map([[1, makeStage({ stageFailureReason: null, taskCount: 100, failedTasks: 50 })]]);
    expect(analyze(makeApp(), stages, [], []).filter(b => b.type === 'stageFailed')).toHaveLength(0);
  });

  it('attaches numTasks, memoryBytesSpilled, and failedTaskDetails from the stage', () => {
    const sample = { taskId: 5, attemptNumber: 0, host: 'h1', executorId: 'e1', reason: 'ExecutorLostFailure', peakExecMem: 100, memSpilled: 0, shuffleWrite: 0 };
    const stages = new Map([[1, makeStage({
      stageFailureReason: 'Job aborted due to stage failure',
      taskCount: 42, memoryBytesSpilled: 999,
      failedTaskSamples: [sample],
    })]]);
    const b = analyze(makeApp(), stages, [], []).find((x) => x.type === 'stageFailed');
    expect(b.numTasks).toBe(42);
    expect(b.memoryBytesSpilled).toBe(999);
    expect(b.failedTaskDetails).toEqual([sample]);
  });

  it('defaults failedTaskDetails to an empty array when the stage carries no samples', () => {
    const stages = new Map([[1, makeStage({ stageFailureReason: 'x', failedTasks: 0 })]]);
    const b = analyze(makeApp(), stages, [], []).find((x) => x.type === 'stageFailed');
    expect(b.failedTaskDetails).toEqual([]);
  });
});

describe('analyze: retry waste', () => {
  it('emits no bottleneck below the 3-attempt/30s floor', () => {
    const stages = new Map([[1, makeStage({ wastedAttempts: 2, retryWasteMs: 40000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.filter(b => b.type === 'retryWaste')).toHaveLength(0);
  });

  it('emits a retryWaste finding at >=3 attempts and >=30s wasted, reconciled to critical here', () => {
    // Detector grades 'warning'; deriveImpactBand promotes to 'critical' (45s wasted is well over 2% of the 5s default).
    const stages = new Map([[1, makeStage({ wastedAttempts: 3, retryWasteMs: 45000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const found = catalog.filter(b => b.type === 'retryWaste');
    expect(found).toHaveLength(1);
    expect(found[0].impactBand).toBe('critical');
  });

  it('emits critical at >=5 minutes wasted', () => {
    const stages = new Map([[1, makeStage({ wastedAttempts: 4, retryWasteMs: 360000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.filter(b => b.type === 'retryWaste')[0].impactBand).toBe('critical');
  });

  it('attaches numTasks, memoryBytesSpilled, and retriedTaskDetails from the stage', () => {
    const sample = { taskId: 7, attemptNumber: 0, host: 'h2', executorId: 'e2', reason: 'FetchFailed', peakExecMem: 200, memSpilled: 10, shuffleWrite: 20 };
    const stages = new Map([[1, makeStage({
      wastedAttempts: 3, retryWasteMs: 45000,
      taskCount: 10, memoryBytesSpilled: 555,
      retryTaskSamples: [sample],
    })]]);
    const b = analyze(makeApp(), stages, [], []).find((x) => x.type === 'retryWaste');
    expect(b.numTasks).toBe(10);
    expect(b.memoryBytesSpilled).toBe(555);
    expect(b.retriedTaskDetails).toEqual([sample]);
  });
});

describe('analyze: speculation waste', () => {
  it('emits no bottleneck below the 5-attempt/60s floor', () => {
    const stages = new Map([[1, makeStage({ speculationWastedAttempts: 4, speculationWasteMs: 90000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.filter(b => b.type === 'speculationWaste')).toHaveLength(0);
  });

  it('emits a speculationWaste finding at >=5 attempts and >=60s wasted, reconciled to critical here', () => {
    // Detector grades 'warning'; deriveImpactBand promotes to 'critical' (90s wasted is well over 2% of the 5s default).
    // 90s is exactly 1.5x the 60s minWasteMs floor: the weakest confidence this detector reports.
    const stages = new Map([[1, makeStage({ speculationWastedAttempts: 5, speculationWasteMs: 90000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const found = catalog.filter(b => b.type === 'speculationWaste');
    expect(found).toHaveLength(1);
    expect(found[0].impactBand).toBe('critical');
    expect(found[0].confidence).toBe('low');
    expect(found[0].docAnchor).toBe('#bottleneck-straggler');
  });

  it('emits critical at >=10 minutes wasted, with high confidence (4x+ the 60s floor)', () => {
    const stages = new Map([[1, makeStage({ speculationWastedAttempts: 6, speculationWasteMs: 700000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const found = catalog.filter(b => b.type === 'speculationWaste')[0];
    expect(found.impactBand).toBe('critical');
    expect(found.confidence).toBe('high');
  });

  it('marks speculationWaste confidence medium between 1.5x and 4x the 60s floor', () => {
    const stages = new Map([[1, makeStage({ speculationWastedAttempts: 5, speculationWasteMs: 150000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.filter(b => b.type === 'speculationWaste')[0].confidence).toBe('medium');
  });

  it('does not fire retryWaste for a pure-speculation stage', () => {
    const stages = new Map([[1, makeStage({ speculationWastedAttempts: 6, speculationWasteMs: 700000, wastedAttempts: 0, retryWasteMs: 0 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.filter(b => b.type === 'retryWaste')).toHaveLength(0);
  });
});

describe('analyze: tiny tasks', () => {
  it('emits no bottleneck with fewer than 100 tasks', () => {
    const stages = new Map([[1, makeStage({ taskCount: 50, taskDurationP50: 100, taskDurationP95: 200 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.filter(b => b.type === 'tinyTask')).toHaveLength(0);
  });

  it('emits a tinyTask finding when >=100 tasks with P50<=500ms and P95<=1000ms, reconciled to critical here', () => {
    // Detector always emits 'info'; deriveImpactBand promotes to 'critical' (150 tiny tasks clear the 2% floor of the 5s default).
    const stages = new Map([[1, makeStage({ taskCount: 150, taskDurationP50: 80, taskDurationP95: 150 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const found = catalog.filter(b => b.type === 'tinyTask');
    expect(found).toHaveLength(1);
    expect(found[0].impactBand).toBe('critical');
  });

  it('skips a stage under 0.5% of the run, and keeps a longer one at its warning tier', () => {
    const run = makeApp({ endTime: 400_000 });
    const at = (completedAt) => analyze(run, new Map([[1, makeStage({ taskCount: 1000, taskDurationP50: 80, taskDurationP95: 150, completedAt })]]), [], [])
      .filter(b => b.type === 'tinyTask');
    expect(at(1000)).toHaveLength(0); // 0.25% of the run: the tasks are tiny, the floor drops it
    const kept = at(4000); // 1%: 900 excess tasks x 50ms, clipped to the stage, clear the 0.5% floor
    expect(kept).toHaveLength(1);
    expect(kept[0].impactBand).toBe('warning');
  });

  it('does not fire when P95 exceeds the 1000ms ceiling despite a low P50', () => {
    const stages = new Map([[1, makeStage({ taskCount: 150, taskDurationP50: 80, taskDurationP95: 1500 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.filter(b => b.type === 'tinyTask')).toHaveLength(0);
  });

  it('mentions spark.sql.shuffle.partitions when the stage is shuffle-fed', () => {
    const stages = new Map([[1, makeStage({ taskCount: 150, taskDurationP50: 80, taskDurationP95: 150, shuffleReadBytes: 1024 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const found = catalog.filter(b => b.type === 'tinyTask');
    expect(found).toHaveLength(1);
    expect(found[0].recommendation).toContain('spark.sql.shuffle.partitions');
  });

  it('omits spark.sql.shuffle.partitions wording when the stage has no shuffle read', () => {
    const stages = new Map([[1, makeStage({ taskCount: 150, taskDurationP50: 80, taskDurationP95: 150, shuffleReadBytes: 0 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const found = catalog.filter(b => b.type === 'tinyTask');
    expect(found[0].recommendation).not.toContain('spark.sql.shuffle.partitions');
    expect(found[0].recommendation).toContain('.coalesce(15)');
  });
});

function makeJob(id, succeeded) {
  return { id, submissionTime: 0, stageIds: [], result: succeeded ? 'JobSucceeded' : 'JobFailed', succeeded, exception: null, completionTime: 100 };
}

describe('analyze: job failure rate', () => {
  const noStages = new Map();

  it('emits nothing when jobs are absent (older call sites pass no jobs)', () => {
    const catalog = analyze(makeApp(), noStages, [], []);
    expect(catalog.filter(b => b.type === 'jobFailureRate')).toHaveLength(0);
  });

  it('emits nothing when all jobs succeeded', () => {
    const jobs = new Map([[0, makeJob(0, true)], [1, makeJob(1, true)]]);
    const catalog = analyze(makeApp(), noStages, [], [], jobs);
    expect(catalog.filter(b => b.type === 'jobFailureRate')).toHaveLength(0);
  });

  it('ignores jobs that never completed (result === null)', () => {
    const running = { id: 2, submissionTime: 0, stageIds: [], result: null, succeeded: null, exception: null, completionTime: null };
    const jobs = new Map([[0, makeJob(0, true)], [1, makeJob(1, true)], [2, running]]);
    const catalog = analyze(makeApp(), noStages, [], [], jobs);
    // 0 of 2 completed jobs failed → below the 10% floor.
    expect(catalog.filter(b => b.type === 'jobFailureRate')).toHaveLength(0);
  });

  it('emits info at >=10% job-failure rate', () => {
    // 1 failed of 10 completed = 10%.
    const jobs = new Map();
    for (let i = 0; i < 9; i++) jobs.set(i, makeJob(i, true));
    jobs.set(9, makeJob(9, false));
    const b = analyze(makeApp(), noStages, [], [], jobs).find(x => x.type === 'jobFailureRate');
    expect(b).toBeTruthy();
    expect(b.impactBand).toBe('info');
    expect(b.value).toBe(10);
    expect(b.failedJobs).toBe(1);
    expect(b.totalJobs).toBe(10);
    expect(b.stageId).toBeNull();
  });

  it('emits warning at >=30% and critical at >=50%', () => {
    const warnJobs = new Map([[0, makeJob(0, false)], [1, makeJob(1, false)], [2, makeJob(2, true)]]); // 2/3 = 66% -> critical
    expect(analyze(makeApp(), noStages, [], [], warnJobs).find(x => x.type === 'jobFailureRate').impactBand).toBe('critical');

    const jobs = new Map();
    for (let i = 0; i < 10; i++) jobs.set(i, makeJob(i, i < 3 ? false : true)); // 3/10 = 30% -> warning
    expect(analyze(makeApp(), noStages, [], [], jobs).find(x => x.type === 'jobFailureRate').impactBand).toBe('warning');
  });

  it('surfaces task-failure context alongside the job rate', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, failedTasks: 20 })]]);
    const jobs = new Map();
    for (let i = 0; i < 9; i++) jobs.set(i, makeJob(i, true));
    jobs.set(9, makeJob(9, false));
    const b = analyze(makeApp(), stages, [], [], jobs).find(x => x.type === 'jobFailureRate');
    expect(b.failedTasks).toBe(20);
    expect(b.totalTasks).toBe(100);
    expect(b.taskFailureRate).toBe(20);
  });
});

describe('analyze: spill confidence metadata', () => {
  it('marks classified spill (skew/volume) as medium confidence', () => {
    const stages = new Map([[1, makeStage({ memoryBytesSpilled: 1024, spillClassification: 'volume' })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'spill');
    expect(b.confidence).toBe('medium');
    expect(b.validationRequired).toMatch(/Spark UI/);
  });

  it('marks unclassified spill as low confidence', () => {
    const stages = new Map([[1, makeStage({ memoryBytesSpilled: 1024, spillClassification: 'unclassified' })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'spill');
    expect(b.confidence).toBe('low');
  });

  it('marks skew confidence low just past ratioWarn (3.1x), medium a bit further out (6x)', () => {
    const borderline = new Map([[1, makeStage({ taskDurationP50: 100, taskDurationP95: 310 })]]);
    const b1 = analyze(makeApp(), borderline, [], []).find(x => x.type === 'skew');
    expect(b1.confidence).toBe('low');
    expect(b1.validationRequired).toMatch(/noise floor/);

    const mid = new Map([[1, makeStage({ taskDurationP50: 100, taskDurationP95: 600 })]]);
    const b2 = analyze(makeApp(), mid, [], []).find(x => x.type === 'skew');
    expect(b2.confidence).toBe('medium');
  });

  it('marks skew confidence high many multiples past ratioWarn (a 50x P95/median ratio)', () => {
    const stages = new Map([[1, makeStage({ taskDurationP50: 100, taskDurationP95: 5000 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'skew');
    expect(b.confidence).toBe('high');
  });

  it('marks straggler confidence low just past shareWarn, high once it clears critPct', () => {
    // 6/100 = 6% straggler share, just past the 5% shareWarn floor.
    const borderline = new Map([[1, makeStage({ taskCount: 100, stragglerCount: 6, taskDurationP50: 100, taskDurationMax: 500 })]]);
    const b1 = analyze(makeApp(), borderline, [], []).find(x => x.type === 'straggler');
    expect(b1.confidence).toBe('low');
    expect(b1.validationRequired).toMatch(/noise floor/);

    // 5/20 = 25% straggler share, well past critPct (20%).
    const strong = new Map([[1, makeStage({ taskCount: 20, stragglerCount: 5, taskDurationP50: 100, taskDurationMax: 500 })]]);
    const b2 = analyze(makeApp(), strong, [], []).find(x => x.type === 'straggler');
    expect(b2.confidence).toBe('high');
  });

  it('marks gc confidence low just past warnPct100 (10%), high several multiples out (35%)', () => {
    const borderline = new Map([[1, makeStage({ gcPct: 15, executorRunTime: 60000 })]]);
    const b1 = analyze(makeApp(), borderline, [], []).find(x => x.type === 'gc' && x.direction !== 'low');
    expect(b1.confidence).toBe('low');
    expect(b1.validationRequired).toMatch(/noise floor/);

    const strong = new Map([[1, makeStage({ gcPct: 35, executorRunTime: 60000 })]]);
    const b2 = analyze(makeApp(), strong, [], []).find(x => x.type === 'gc' && x.direction !== 'low');
    expect(b2.confidence).toBe('high');
  });

  it('marks low-GC (over-provisioned) confidence high near zero, low just under lowInfoPct100', () => {
    const borderline = new Map([[1, makeStage({ gcPct: 4, executorRunTime: 60000 })]]);
    const b1 = analyze(makeApp(), borderline, [], []).find(x => x.type === 'gc' && x.direction === 'low');
    expect(b1.confidence).toBe('low');

    const strong = new Map([[1, makeStage({ gcPct: 0.5, executorRunTime: 60000 })]]);
    const b2 = analyze(makeApp(), strong, [], []).find(x => x.type === 'gc' && x.direction === 'low');
    expect(b2.confidence).toBe('high');
  });
});

describe('analyze: spill impact band v2 (§5)', () => {
  // Each case asserts the detector's own spillMagnitude tier alongside .impactBand; these volumes fall under
  // the 0.5% warn floor of the 5s default, so all demote to info. Test names describe the magnitude tier, not the reconciled band.
  const GiB = 1024 * 1024 * 1024, MiB = 1024 * 1024;
  it('single-task stage with ≥1GiB disk spill has its own severe magnitude tier, reconciled to info here', () => {
    const stages = new Map([[1, makeStage({ taskCount: 1, memoryBytesSpilled: 100, spillDiskMax: 2 * GiB, spillMemMax: 0, spillClassification: 'volume' })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'spill');
    expect(b.impactBand).toBe('info');
    expect(b.spillMagnitude).toBe('severe');
  });
  it('multi-task medium disk spill has its own medium magnitude tier, reconciled to info here', () => {
    const stages = new Map([[1, makeStage({ taskCount: 50, memoryBytesSpilled: 100, spillDiskMax: 300 * MiB, spillMemMax: 0, spillClassification: 'volume' })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'spill');
    expect(b.impactBand).toBe('info');
    expect(b.spillMagnitude).toBe('medium');
  });
  it('skew below the disk floor does not fire 5b (no magnitude tier), reconciled to info here', () => {
    const stages = new Map([[1, makeStage({ taskCount: 50, memoryBytesSpilled: 100, spillDiskP50: 1 * MiB, spillDiskMax: 100 * MiB, spillMemMax: 0, spillClassification: 'skew' })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'spill');
    expect(b.impactBand).toBe('info');
    expect(b.spillMagnitude).toBeUndefined();
  });
  it('multi-task memory spill at 1GiB (old medium floor) still gets its own medium magnitude tier (not high), reconciled to info here', () => {
    const stages = new Map([[1, makeStage({ taskCount: 50, memoryBytesSpilled: 100, spillDiskMax: 0, spillMemMax: 1 * GiB, spillClassification: 'volume' })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'spill');
    expect(b.impactBand).toBe('info');
    expect(b.spillMagnitude).toBe('medium');
  });
  it('multi-task memory spill ≥4GiB has its own high magnitude tier, reconciled to info here', () => {
    const stages = new Map([[1, makeStage({ taskCount: 50, memoryBytesSpilled: 100, spillDiskMax: 0, spillMemMax: 5 * GiB, spillClassification: 'volume' })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'spill');
    expect(b.impactBand).toBe('info');
    expect(b.spillMagnitude).toBe('high');
  });
  it('multi-task memory spill at exactly 4GiB has its own high magnitude tier (inclusive floor), reconciled to info here', () => {
    const stages = new Map([[1, makeStage({ taskCount: 50, memoryBytesSpilled: 100, spillDiskMax: 0, spillMemMax: 4 * GiB, spillClassification: 'volume' })]]);
    const b = analyze(makeApp(), stages, [], []).find(b => b.type === 'spill');
    expect(b.impactBand).toBe('info');
    expect(b.spillMagnitude).toBe('high');
  });
  it('multi-task disk spill magnitude tiers are unaffected by the memory high-tier addition (both reconcile to info here)', () => {
    // Both carry distinct spillMagnitude tiers (high vs medium, the regression guard) but reconcile to the same info band; the distinction survives in spillMagnitude, not .impactBand.
    const highStages = new Map([[1, makeStage({ taskCount: 50, memoryBytesSpilled: 100, spillDiskMax: 2 * GiB, spillMemMax: 0, spillClassification: 'volume' })]]);
    const high = analyze(makeApp(), highStages, [], []).find(b => b.type === 'spill');
    expect(high.impactBand).toBe('info');
    expect(high.spillMagnitude).toBe('high');

    const medStages = new Map([[1, makeStage({ taskCount: 50, memoryBytesSpilled: 100, spillDiskMax: 300 * MiB, spillMemMax: 0, spillClassification: 'volume' })]]);
    const med = analyze(makeApp(), medStages, [], []).find(b => b.type === 'spill');
    expect(med.impactBand).toBe('info');
    expect(med.spillMagnitude).toBe('medium');
  });
});

describe('analyze: incomplete run', () => {
  it('emits an incompleteRun finding when the app never recorded an ApplicationEnd', () => {
    const app = makeApp({ startTime: 0, endTime: null });
    const finding = analyze(app, new Map(), [], []).find((f) => f.type === 'incompleteRun');
    expect(finding).toBeDefined();
    expect(finding.impactBand).toBe('warning');
  });

  it('emits no incompleteRun finding when the app recorded an ApplicationEnd', () => {
    expect(analyze(makeApp(), new Map(), [], []).find((f) => f.type === 'incompleteRun')).toBeUndefined();
  });

  it('emits no incompleteRun finding when there is no evidence of a run at all (no startTime)', () => {
    const app = makeApp({ startTime: undefined, endTime: undefined });
    expect(analyze(app, new Map(), [], []).find((f) => f.type === 'incompleteRun')).toBeUndefined();
  });
});

describe('auditConfig: static config sanity', () => {
  function appWith(config, resourceOverrides = {}) {
    const res = {
      executor: { memoryMB: null, memoryOverheadMB: null, cores: null, instances: null },
      driver: {},
      dynamicAllocationEnabled: null, shuffleServiceEnabled: null, serializer: null,
      ...resourceOverrides,
    };
    return { config, resources: res };
  }

  it('returns nothing for an older log with no config and no resources', () => {
    expect(auditConfig({ config: {}, resources: null })).toHaveLength(0);
    expect(auditConfig(null)).toHaveLength(0);
  });

  it('memoizes per app object identity: repeated calls skip recomputation but still return a fresh array', () => {
    const app = appWith(
      { 'spark.dynamicAllocation.enabled': 'true', 'spark.shuffle.service.enabled': 'false', 'spark.serializer': 'kryo' },
      { dynamicAllocationEnabled: true, shuffleServiceEnabled: false, serializer: 'org.apache.spark.serializer.KryoSerializer' },
    );
    const first = auditConfig(app);
    const second = auditConfig(app);
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toBe(second); // fresh array each call: a caller mutating one in place can't corrupt the other
    expect(first).toEqual(second); // same content
    // Same underlying Finding object on both calls proves the second call served the cache
    // instead of re-running every config-scope detector.
    expect(first[0]).toBe(second[0]);
  });

  it('does not share the cache across two different app objects, even with identical config', () => {
    const buildApp = () => appWith(
      { 'spark.dynamicAllocation.enabled': 'true', 'spark.shuffle.service.enabled': 'false', 'spark.serializer': 'kryo' },
      { dynamicAllocationEnabled: true, shuffleServiceEnabled: false, serializer: 'org.apache.spark.serializer.KryoSerializer' },
    );
    const a = auditConfig(buildApp());
    const b = auditConfig(buildApp());
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]).not.toBe(b[0]);
  });

  it('never caches a null app (WeakMap cannot key on null) and still returns a fresh empty array each call', () => {
    const first = auditConfig(null);
    const second = auditConfig(null);
    expect(first).not.toBe(second);
    expect(first).toEqual([]);
  });

  it('flags dynamic-allocation + disabled shuffle service (warning)', () => {
    const app = appWith(
      { 'spark.dynamicAllocation.enabled': 'true', 'spark.shuffle.service.enabled': 'false', 'spark.serializer': 'kryo' },
      { dynamicAllocationEnabled: true, shuffleServiceEnabled: false, serializer: 'org.apache.spark.serializer.KryoSerializer' },
    );
    const f = auditConfig(app).find(x => x.property === 'spark.shuffle.service.enabled');
    expect(f).toBeTruthy();
    expect(f.impactBand).toBe('warning');
  });

  it('flags inverted autoscaling bounds (critical) and every offending property', () => {
    const app = appWith(
      { 'spark.dynamicAllocation.enabled': 'true', 'spark.dynamicAllocation.minExecutors': '10', 'spark.dynamicAllocation.maxExecutors': '5', 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
      { dynamicAllocationEnabled: true, shuffleServiceEnabled: true, serializer: 'org.apache.spark.serializer.KryoSerializer' },
    );
    const findings = auditConfig(app);
    const inv = findings.find(x => x.property === 'spark.dynamicAllocation.minExecutors');
    expect(inv.impactBand).toBe('critical');
  });

  it('flags a missing max bound when dynamic allocation is on (info)', () => {
    const app = appWith(
      { 'spark.dynamicAllocation.enabled': 'true', 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
      { dynamicAllocationEnabled: true, shuffleServiceEnabled: true, serializer: 'org.apache.spark.serializer.KryoSerializer' },
    );
    const f = auditConfig(app).find(x => x.property === 'spark.dynamicAllocation.maxExecutors');
    expect(f.impactBand).toBe('info');
  });

  it('flags a non-Kryo / missing serializer (info)', () => {
    const app = appWith(
      { 'spark.executor.memory': '4g' },
      { serializer: null },
    );
    const f = auditConfig(app).find(x => x.property === 'spark.serializer');
    expect(f.impactBand).toBe('info');
  });

  it('does not flag serializer when Kryo is set', () => {
    const app = appWith(
      { 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
      { serializer: 'org.apache.spark.serializer.KryoSerializer' },
    );
    expect(auditConfig(app).find(x => x.property === 'spark.serializer')).toBeUndefined();
  });

  it('flags memoryOverhead below Spark default floor (info)', () => {
    // 10 GiB executor → floor = max(384, 1024) = 1024 MiB; overhead 256 is below.
    const app = appWith(
      { 'spark.executor.memory': '10g', 'spark.executor.memoryOverhead': '256', 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
      { executor: { memoryMB: 10240, memoryOverheadMB: 256 }, serializer: 'org.apache.spark.serializer.KryoSerializer' },
    );
    const f = auditConfig(app).find(x => x.property === 'spark.executor.memoryOverhead');
    expect(f.impactBand).toBe('info');
  });

  it('does not flag memoryOverhead when at/above the floor', () => {
    const app = appWith(
      { 'spark.executor.memory': '10g', 'spark.executor.memoryOverhead': '2048', 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
      { executor: { memoryMB: 10240, memoryOverheadMB: 2048 }, serializer: 'org.apache.spark.serializer.KryoSerializer' },
    );
    expect(auditConfig(app).find(x => x.property === 'spark.executor.memoryOverhead')).toBeUndefined();
  });
});

describe('detector contract', () => {
  it('every DETECTORS entry has the required contract fields', () => {
    for (const d of DETECTORS) {
      expect(typeof d.type).toBe('string');
      expect(['stage', 'app', 'config', 'sql']).toContain(d.scope);
      expect(typeof d.detect).toBe('function');
      // autoscalingChurn and incompleteRun deliberately have no docAnchor (documented deviation)
      if (d.type !== 'autoscalingChurn' && d.type !== 'incompleteRun') {
        expect(typeof d.docAnchor).toBe('string');
        expect(d.docAnchor.startsWith('#')).toBe(true);
      }
    }
  });

  it('every finding analyze() returns carries a docAnchor string', () => {
    const findings = analyze(sampleApp, sampleStages, sampleAdded, sampleRemoved, sampleJobs);
    for (const f of findings) expect(typeof f.docAnchor).toBe('string');
  });

  it('slowHost is declared before stageSlowness in DETECTORS (suppression precondition)', () => {
    const iHost = DETECTORS.findIndex(d => d.type === 'slowHost');
    const iSlow = DETECTORS.findIndex(d => d.type === 'stageSlowness');
    expect(iHost).toBeGreaterThanOrEqual(0);
    expect(iSlow).toBeGreaterThan(iHost);
  });

  it('detectorCatalog() returns one metadata row per detector entry', () => {
    const catalog = detectorCatalog();
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog).toHaveLength(DETECTORS.length);
  });

  it('detectorCatalog() rows expose { type, version, scope, thresholds, docAnchor } with version >= 1', () => {
    for (const row of detectorCatalog()) {
      expect(typeof row.type).toBe('string');
      expect(typeof row.scope).toBe('string');
      expect(typeof row.version).toBe('number');
      expect(row.version).toBeGreaterThanOrEqual(1);
      expect(row).toHaveProperty('thresholds');
      expect(row).toHaveProperty('docAnchor');
    }
  });
});

describe('detector extended-field whitelist', () => {
  it('no DETECTORS entry carries a static top-level extended string', () => {
    for (const d of DETECTORS) {
      expect(d.extended, `${d.type} (${d.property ?? ''}) has a static top-level extended`).toBeUndefined();
    }
  });

  it('analyze() results have a docAnchor and no extended unless retryWaste', () => {
    const stage = makeStage({
      taskCount: 100,
      taskDurationP50: 100, taskDurationP95: 600, taskDurationMax: 600, // skew
      shuffleReadBytes: 2 * 1024 * 1024 * 1024,                          // shuffle
      memoryBytesSpilled: 5 * 1024 * 1024,                               // spill
      gcPct: 25, jvmGCTime: 2500,                                        // gc
      failedTasks: 30,                                                   // failures
      wastedAttempts: 5, retryWasteMs: 60000,                            // retryWaste
    });
    const catalog = analyze(makeApp(), new Map([[1, stage]]), [], [], new Map());
    expect(catalog.some(b => b.type === 'retryWaste')).toBe(true);
    for (const b of catalog) {
      expect(typeof b.docAnchor).toBe('string');
      if (b.type === 'retryWaste') expect(typeof b.extended).toBe('string');
      else expect(b, `${b.type} still has extended`).not.toHaveProperty('extended');
    }
  });

  it('auditConfig() results carry no extended', () => {
    const app = makeApp({ config: { 'spark.master': 'yarn' } }); // triggers the serializer info finding
    for (const b of auditConfig(app)) {
      expect(b, `${b.property} still has extended`).not.toHaveProperty('extended');
    }
  });
});

describe('analyze: GC low direction (ExecutorGcHeuristic inverted)', () => {
  it('emits an info low-GC finding when gcPct is under 5% and stage ran long enough', () => {
    const stages = new Map([[1, makeStage({ gcPct: 3, executorRunTime: 60000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const low = catalog.find(b => b.type === 'gc' && b.direction === 'low');
    expect(low).toBeTruthy();
    expect(low.impactBand).toBe('info');
    expect(low.stageId).toBe(1);
    expect(low.recommendation).toMatch(/over-provisioned/i);
  });

  it('does not fire on a short stage even when gcPct is 0 (noise floor)', () => {
    const stages = new Map([[1, makeStage({ gcPct: 0, executorRunTime: 5000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find(b => b.type === 'gc' && b.direction === 'low')).toBeUndefined();
  });

  it('skips a low-GC note on a stage shorter than 0.5% of the run, but never a high-GC finding', () => {
    // A 1s stage in a 400s run (0.25%): low GC is still true there, the floor is why it's dropped.
    const low = new Map([[1, makeStage({ gcPct: 3, executorRunTime: 60000, submittedAt: 0, completedAt: 1000 })]]);
    expect(analyze(makeApp({ endTime: 400_000 }), low, [], []).find(b => b.type === 'gc')).toBeUndefined();
    const lowLong = new Map([[1, makeStage({ gcPct: 3, executorRunTime: 60000, submittedAt: 0, completedAt: 4000 })]]);
    expect(analyze(makeApp({ endTime: 400_000 }), lowLong, [], []).find(b => b.type === 'gc' && b.direction === 'low')).toBeTruthy();
    const high = new Map([[1, makeStage({ gcPct: 15, jvmGCTime: 9000, executorRunTime: 60000, submittedAt: 0, completedAt: 1000 })]]);
    expect(analyze(makeApp({ endTime: 400_000 }), high, [], []).find(b => b.type === 'gc' && b.direction !== 'low')).toBeTruthy();
  });

  it('does not emit a low finding when GC is high', () => {
    const stages = new Map([[1, makeStage({ gcPct: 15, executorRunTime: 60000 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find(b => b.type === 'gc' && b.direction === 'low')).toBeUndefined();
    expect(catalog.find(b => b.type === 'gc' && b.direction !== 'low')).toBeTruthy();
  });

  it('does not fire a high-GC finding on a near-instant stage (noise floor)', () => {
    // Tiny executorRunTime denominator inflates gcPct past critical though the stage barely ran: same noise floor as low-GC.
    const stages = new Map([[1, makeStage({ gcPct: 300, executorRunTime: 500 })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find(b => b.type === 'gc' && b.direction !== 'low')).toBeUndefined();
  });

  it('still fires at its own warning/critical gcPct tiers on a stage that ran long enough, both reconciled to info here', () => {
    // Detector grades warning at 15% / critical at 25%, but GC time here is under the 0.5% warn floor of the 5s default, so both demote to info.
    const warnStages = new Map([[1, makeStage({ gcPct: 15, executorRunTime: 60000 })]]);
    const warn = analyze(makeApp(), warnStages, [], []).find(b => b.type === 'gc' && b.direction !== 'low');
    expect(warn?.impactBand).toBe('info');

    const critStages = new Map([[1, makeStage({ gcPct: 25, executorRunTime: 60000 })]]);
    const crit = analyze(makeApp(), critStages, [], []).find(b => b.type === 'gc' && b.direction !== 'low');
    expect(crit?.impactBand).toBe('info');
  });

  it('fires at exactly minRunTimeMs (inclusive floor), reconciled to info here', () => {
    // Detector grades 'critical' at 25%, demoted to 'info' for the same reason as above.
    const stages = new Map([[1, makeStage({ gcPct: 25, executorRunTime: 10000 })]]);
    const crit = analyze(makeApp(), stages, [], []).find(b => b.type === 'gc' && b.direction !== 'low');
    expect(crit?.impactBand).toBe('info');
  });
});

describe('analyze: CPU utilization metric (sparkMeasure, metric-only)', () => {
  it('attaches cpuUtilizationPct to the utilization finding', () => {
    // 8 total cores, app ran 10s. executorCpuTime is nanoseconds: 16000000000ns = 16000ms => 16000/(10000*8) = 20%.
    const app = makeApp({ startTime: 1000, endTime: 11000, resources: { executor: { cores: 4 } } });
    const stages = new Map([[1, makeStage({ executorRunTime: 100000, executorCpuTime: 16000000000 })]]);
    const added = [
      { executorId: '1', timestamp: 1000, totalCores: 4 },
      { executorId: '2', timestamp: 1000, totalCores: 4 },
    ];
    const removed = [{ executorId: '2', timestamp: 2000 }]; // exec 2 leaves early => util < 60% (avg 1.1/2=55%)
    const catalog = analyze(app, stages, added, removed);
    const util = catalog.find(b => b.type === 'utilization');
    expect(util).toBeTruthy();
    expect(util.cpuUtilizationPct).toBe(20);
    // Sanity bound: CPU utilization should never be wildly above 100% of core-time (some measurement slack).
    expect(util.cpuUtilizationPct).toBeGreaterThanOrEqual(0);
    expect(util.cpuUtilizationPct).toBeLessThanOrEqual(150);
  });

  it('sets cpuUtilizationPct to null when cores are unknown', () => {
    const app = makeApp({ startTime: 1000, endTime: 11000, resources: { executor: { cores: null } } });
    const stages = new Map([[1, makeStage({ executorCpuTime: 16000 })]]);
    const added = [{ executorId: '1', timestamp: 1000, totalCores: 0 }];
    const catalog = analyze(app, stages, added, []);
    const util = catalog.find(b => b.type === 'utilization');
    if (util) expect(util.cpuUtilizationPct).toBeNull();
  });

  it('carries the raw 0-1 utilizationFraction alongside the rounded percentage value', () => {
    const app = makeApp({ startTime: 1000, endTime: 11000, resources: { executor: { cores: 4 } } });
    const stages = new Map([[1, makeStage({ executorRunTime: 100000, executorCpuTime: 16000000000 })]]);
    const added = [
      { executorId: '1', timestamp: 1000, totalCores: 4 },
      { executorId: '2', timestamp: 1000, totalCores: 4 },
    ];
    const removed = [{ executorId: '2', timestamp: 2000 }]; // exec 2 leaves early => util < 60% (avg 1.1/2=55%)
    const catalog = analyze(app, stages, added, removed);
    const finding = catalog.find(b => b.type === 'utilization');
    expect(finding).toBeDefined();
    expect(typeof finding.utilizationFraction).toBe('number');
    expect(finding.utilizationFraction).toBeGreaterThanOrEqual(0);
    expect(finding.utilizationFraction).toBeLessThanOrEqual(1);
    expect(finding.value).toBe(Math.round(finding.utilizationFraction * 100));
  });
});

describe('analyze: utilization detector tolerates a null app', () => {
  it('does not throw when app is null (ApplicationStart never parsed)', () => {
    const added = [
      { executorId: '1', timestamp: 1000, totalCores: 4 },
      { executorId: '2', timestamp: 1000, totalCores: 4 },
    ];
    const removed = [{ executorId: '2', timestamp: 2000 }];
    const catalog = analyze(null, new Map(), added, removed);
    expect(catalog.find(b => b.type === 'utilization')).toBeUndefined();
  });
});

describe('analyze: utilization detector under executor churn (regression)', () => {
  // Audit repro: 2 executors x 4 cores (8 cores) held continuously for 100s, with 3 mid-run
  // replacement events (spot preemption / dynamicAllocation replacement pattern). Concurrency
  // never exceeds 2 executors / 8 cores, but 5 executors are added over the run's lifetime, so
  // executorsAdded.length x cores or computeTotalCores would report 20 cores: a 2.5x inflation.
  function churnedExecutors() {
    const added = [
      { executorId: 'a', timestamp: 0, totalCores: 4 },
      { executorId: 'b', timestamp: 0, totalCores: 4 },
      { executorId: 'c', timestamp: 25000, totalCores: 4 },
      { executorId: 'd', timestamp: 50000, totalCores: 4 },
      { executorId: 'e', timestamp: 75000, totalCores: 4 },
    ];
    const removed = [
      { executorId: 'a', timestamp: 25000 },
      { executorId: 'b', timestamp: 50000 },
      { executorId: 'c', timestamp: 75000 },
    ];
    return { added, removed };
  }

  it('reports totalCores as the real peak concurrent capacity (8), not the cumulative sum (20)', () => {
    const app = makeApp({ startTime: 0, endTime: 100000, resources: { executor: { cores: 4 } } });
    const { added, removed } = churnedExecutors();
    const ra = { coreHistogram: [], busyCoreMs: 50000, peakConcurrentCores: 8, perStage: {} };
    const catalog = analyze(app, new Map(), added, removed, sampleJobs, new Map(), ra);
    const util = catalog.find(b => b.type === 'utilization');
    expect(util).toBeTruthy();
    expect(util.totalCores).toBe(8);
    // Honest utilization: busyCoreMs 50000 / (8 cores x 100000ms) = 6.25%, not the churn-inflated
    // 50000 / (20 cores x 100000ms) = 2.5% computeTotalCores would have produced.
    expect(util.value).toBe(Math.round((50000 / (8 * 100000)) * 100));
  });
});

describe('analyze: coldStart/utilization do not silently skip on a literal startTime:0 (regression)', () => {
  it('coldStart still fires when app.startTime is exactly 0', () => {
    // makeApp()'s own default startTime is 0 (fixtures/stage-app-fixtures.js); a falsy check on
    // app.startTime (`!app.startTime`) treats this exactly like a missing startTime and silently
    // no-ops. The first executor arrives well past the 30s default gap after the first stage.
    const app = makeApp({ startTime: 0, endTime: 100000 });
    const stages = new Map([[1, makeStage({ submittedAt: 1000 })]]);
    const added = [{ executorId: '1', timestamp: 42000, totalCores: 4 }];
    const b = analyze(app, stages, added, []).find(x => x.type === 'coldStart');
    expect(b).toBeTruthy();
    expect(b.value).toBe(41);
  });

  // The gap is first runnable stage -> first executor. The driver's own startup before its first
  // job isn't executor wait, and with no executor events there's nothing to measure.
  it('coldStart: ignores driver startup before the first stage, and needs executor events', () => {
    const app = makeApp({ startTime: 0, endTime: 100000 });
    const stages = new Map([[1, makeStage({ submittedAt: 41000 })]]);
    const warm = [{ executorId: '1', timestamp: 30000, totalCores: 4 }];
    expect(analyze(app, stages, warm, []).find(x => x.type === 'coldStart')).toBeUndefined();
    expect(analyze(app, stages, [], []).find(x => x.type === 'coldStart')).toBeUndefined();
    const late = [{ executorId: '2', timestamp: 80000, totalCores: 4 }, { executorId: '1', timestamp: 75000, totalCores: 4 }];
    expect(analyze(app, stages, late, []).find(x => x.type === 'coldStart').value).toBe(34);
  });

  it('utilization still fires when app.startTime is exactly 0', () => {
    const app = makeApp({ startTime: 0, endTime: 100000, resources: { executor: { cores: 4 } } });
    const added = [{ executorId: '1', timestamp: 0, totalCores: 4 }];
    const catalog = analyze(app, new Map([[1, makeStage()]]), added, []);
    const util = catalog.find(b => b.type === 'utilization');
    expect(util).toBeTruthy();
  });
});

describe('analyze: runAggregates threading', () => {
  it('accepts a 7th runAggregates argument without breaking existing detectors', () => {
    const ra = { coreHistogram: [], busyCoreMs: 0, peakConcurrentCores: 0, perStage: {} };
    const catalog = analyze(makeApp(), sampleStages, [], [], sampleJobs, new Map(), ra);
    expect(Array.isArray(catalog)).toBe(true);
  });
});

describe('analyze: memoryUtilization detector (§1)', () => {
  const raBusy = (busyCoreMs, peak) => ({ coreHistogram: [], busyCoreMs, peakConcurrentCores: peak, perStage: {} });

  it('1a: fires idleCores warning when idle-core rate exceeds 50%', () => {
    // peakCores 8, app 10s => capacity 80 core-s. busy 20 core-s => idle 75% > 50%.
    const app = makeApp({ startTime: 0, endTime: 10000, resources: { executor: { cores: 4, memoryMB: 4096 } } });
    const added = [{ executorId: '1', timestamp: 0, totalCores: 4 }, { executorId: '2', timestamp: 0, totalCores: 4 }];
    const ra = raBusy(20000, 8);
    const catalog = analyze(app, new Map([[1, makeStage()]]), added, [], sampleJobs, new Map(), ra);
    const idle = catalog.find(b => b.type === 'memoryUtilization' && b.variant === 'idleCores');
    expect(idle).toBeTruthy();
    expect(idle.impactBand).toBe('warning');
    expect(idle.value).toBe(75);
    // Impact-estimate inputs attached at the push site: unrounded rate plus cluster sizing (value above is rounded).
    expect(idle.idleRateFraction).toBeCloseTo(0.75, 10);
    expect(idle.allocatedMB).toBe(4096);
    expect(idle.peakExecutors).toBe(2);
    expect(idle.appDurationMs).toBe(10000);
  });

  it('1b: flags an executor whose peak heap exceeds 95% of allocated (too small)', () => {
    const app = makeApp({ resources: { executor: { cores: 4, memoryMB: 1000 } } });
    // 1000 MB allocated; jvmHeapMemory is in bytes => 0.98 * 1000 * 1024 * 1024.
    const stage = makeStage({ executorMetrics: new Map([['3', { jvmHeapMemory: Math.round(0.98 * 1000 * 1024 * 1024) }]]) });
    const catalog = analyze(app, new Map([[1, stage]]), [{ executorId: '3', timestamp: 0, totalCores: 4 }], [], sampleJobs, new Map(), raBusy(0, 0));
    const band = catalog.find(b => b.type === 'memoryUtilization' && b.variant === 'memoryBand' && b.executorId === '3');
    expect(band).toBeTruthy();
    expect(band.impactBand).toBe('warning'); // too small
    // Discriminates the OOM-risk band from over-provisioned; no waste figures since near-capacity heap is a risk signal, not waste.
    expect(band.rule).toBe('heapNearCapacity');
    expect(band.allocatedBytes).toBeUndefined();
  });

  it('1b: flags an executor well under the allocated heap as over-provisioned, with the impact-estimate inputs', () => {
    const app = makeApp({ startTime: 0, endTime: 120000, resources: { executor: { cores: 4, memoryMB: 1000 } } });
    // 25% of 1000 MB => below the 0.70 bandTooHigh threshold.
    const heapBytes = Math.round(0.25 * 1000 * 1024 * 1024);
    const stage = makeStage({ executorMetrics: new Map([['3', { jvmHeapMemory: heapBytes }]]) });
    const catalog = analyze(app, new Map([[1, stage]]), [{ executorId: '3', timestamp: 0, totalCores: 4 }], [], sampleJobs, new Map(), raBusy(0, 0));
    const band = catalog.find(b => b.type === 'memoryUtilization' && b.variant === 'memoryBand' && b.executorId === '3');
    expect(band).toBeTruthy();
    expect(band.impactBand).toBe('info');
    expect(band.rule).toBe('heapOverProvisioned');
    expect(band.allocatedBytes).toBe(1000 * 1024 * 1024);
    expect(band.heap).toBe(heapBytes);
    expect(band.appDurationMs).toBe(120000);
  });

  it('1b: emits a dataUnavailable memoryBand finding when no executorMetrics present', () => {
    const app = makeApp({ resources: { executor: { cores: 4, memoryMB: 1000 } } });
    const catalog = analyze(app, new Map([[1, makeStage()]]), [{ executorId: '1', timestamp: 0, totalCores: 4 }], [], sampleJobs, new Map(), raBusy(0, 0));
    const band = catalog.find(b => b.type === 'memoryUtilization' && b.variant === 'memoryBand');
    expect(band?.dataUnavailable).toBe(true);
  });

  it('1c: waste-model finding carries high confidence + validationRequired when waste is many multiples of the gate', () => {
    const app = makeApp({ startTime: 0, endTime: 3600000, resources: { executor: { cores: 4, memoryMB: 4096 } } });
    const added = Array.from({ length: 4 }, (_, i) => ({ executorId: String(i), timestamp: 0, totalCores: 4 }));
    const stage = makeStage({ executorRunTime: 1000 }); // tiny used-time => wasted is ~9600x the 1.5x-gated floor
    const catalog = analyze(app, new Map([[1, stage]]), added, [], sampleJobs, new Map(), raBusy(0, 0));
    const waste = catalog.find(b => b.type === 'memoryUtilization' && b.variant === 'wasteModel');
    expect(waste?.confidence).toBe('high');
    expect(waste?.validationRequired).toBeTruthy();
  });

  it('1c: waste-model finding is low confidence just past the 1.5x wasteBufferMultiplier floor', () => {
    const app = makeApp({ startTime: 0, endTime: 100000, resources: { executor: { cores: 1, memoryMB: 1000 } } });
    const added = [{ executorId: '0', timestamp: 0, totalCores: 1 }];
    // allocatedMBSeconds = 1*1000*100 = 100,000; usedMBSeconds = 1000*34 = 34,000; wasted = 66,000,
    // which is ~1.3x (1.5 * 34,000) = 51,000: just past the gate, the weakest evidence this detector reports.
    const stage = makeStage({ executorRunTime: 34000 });
    const catalog = analyze(app, new Map([[1, stage]]), added, [], sampleJobs, new Map(), raBusy(0, 0));
    const waste = catalog.find(b => b.type === 'memoryUtilization' && b.variant === 'wasteModel');
    expect(waste?.confidence).toBe('low');
  });

  it('1a (regression): executor churn does not inflate idleCores past the real peak concurrent capacity', () => {
    // Audit repro: 2 executors x 4 cores (8 cores) held continuously for 100s, with 3 mid-run
    // replacement events (spot preemption pattern). Concurrency never exceeds 2 executors / 8
    // cores, but 5 executors are added over the run's lifetime: computeTotalCores/
    // executorsAdded.length would report 20 cores / 5 executors, inflating the idle rate from an
    // honest 93.75% (50000 busy / 800000 capacity core-ms) to a churn-inflated 97.5%.
    const app = makeApp({ startTime: 0, endTime: 100000, resources: { executor: { cores: 4, memoryMB: 4096 } } });
    const added = [
      { executorId: 'a', timestamp: 0, totalCores: 4 },
      { executorId: 'b', timestamp: 0, totalCores: 4 },
      { executorId: 'c', timestamp: 25000, totalCores: 4 },
      { executorId: 'd', timestamp: 50000, totalCores: 4 },
      { executorId: 'e', timestamp: 75000, totalCores: 4 },
    ];
    const removed = [
      { executorId: 'a', timestamp: 25000 },
      { executorId: 'b', timestamp: 50000 },
      { executorId: 'c', timestamp: 75000 },
    ];
    const ra = raBusy(50000, 8);
    const catalog = analyze(app, new Map([[1, makeStage()]]), added, removed, sampleJobs, new Map(), ra);
    const idle = catalog.find(b => b.type === 'memoryUtilization' && b.variant === 'idleCores');
    expect(idle).toBeTruthy();
    expect(idle.value).toBe(94); // round(93.75), not the churn-inflated round(97.5) = 98
    expect(idle.idleRateFraction).toBeCloseTo(0.9375, 10);
    expect(idle.peakExecutors).toBe(2); // real peak concurrency, not the 5 executors ever added
  });
});

describe('analyze, cacheUtilization detector', () => {
  const emptyStages = new Map();
  const emptyJobs = new Map();
  const cacheFindings = (app) => analyze(app, emptyStages, [], [], emptyJobs).filter((b) => b.type === 'cacheUtilization');

  function makeRdd(id, overrides = {}) {
    return {
      id, name: `rdd${id}`,
      storageLevel: { useMemory: true, useDisk: false, deserialized: true, replication: 1 },
      numPartitions: 10, numCachedPartitions: 10,
      memorySize: 1000, diskSize: 0,
      ...overrides,
    };
  }

  it('returns no findings when app.rddInfo is absent', () => {
    expect(cacheFindings(makeApp())).toEqual([]);
  });

  it('returns no findings when app.rddInfo is an empty Map', () => {
    expect(cacheFindings(makeApp({ rddInfo: new Map() }))).toEqual([]);
  });

  it('emits nothing for a fully cached, non-spilling RDD', () => {
    const rddInfo = new Map([[1, makeRdd(1)]]);
    expect(cacheFindings(makeApp({ rddInfo }))).toEqual([]);
  });

  it('fires an info partialCache finding just below the 0.90 cachedRatio tier', () => {
    const rddInfo = new Map([[1, makeRdd(1, { numPartitions: 100, numCachedPartitions: 89 })]]); // 0.89
    const partial = cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'partialCache');
    expect(partial.impactBand).toBe('info');
    expect(partial.value).toBe(89);
  });

  it('emits no partialCache finding just above the 0.90 cachedRatio tier', () => {
    const rddInfo = new Map([[1, makeRdd(1, { numPartitions: 100, numCachedPartitions: 91 })]]); // 0.91
    expect(cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'partialCache')).toBeUndefined();
  });

  it('emits no partialCache finding when cachedRatio is exactly 0.90 (info tier upper bound is exclusive)', () => {
    const rddInfo = new Map([[1, makeRdd(1, { numPartitions: 100, numCachedPartitions: 90 })]]);
    expect(cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'partialCache')).toBeUndefined();
  });

  it('fires a warning partialCache finding just below the 0.50 cachedRatio tier', () => {
    const rddInfo = new Map([[1, makeRdd(1, { numPartitions: 100, numCachedPartitions: 49 })]]); // 0.49
    const partial = cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'partialCache');
    expect(partial.impactBand).toBe('warning');
  });

  it('lands in the info tier (not warning) when cachedRatio is exactly 0.50', () => {
    const rddInfo = new Map([[1, makeRdd(1, { numPartitions: 100, numCachedPartitions: 50 })]]);
    const partial = cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'partialCache');
    expect(partial.impactBand).toBe('info');
  });

  it('fires a warning diskSpillover finding just above the 0.40 diskRatio tier', () => {
    const rddInfo = new Map([[1, makeRdd(1, {
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 590, diskSize: 410, // 0.41
    })]]);
    const spill = cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'diskSpillover');
    expect(spill.impactBand).toBe('warning');
    expect(spill.value).toBe(41);
  });

  it('lands in the info tier (not warning) when diskRatio is exactly 0.40', () => {
    const rddInfo = new Map([[1, makeRdd(1, {
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 600, diskSize: 400,
    })]]);
    const spill = cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'diskSpillover');
    expect(spill.impactBand).toBe('info');
  });

  it('fires an info diskSpillover finding just above the 0.15 diskRatio tier', () => {
    const rddInfo = new Map([[1, makeRdd(1, {
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 840, diskSize: 160, // 0.16
    })]]);
    const spill = cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'diskSpillover');
    expect(spill.impactBand).toBe('info');
  });

  it('emits no diskSpillover finding when diskRatio is exactly 0.15', () => {
    const rddInfo = new Map([[1, makeRdd(1, {
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 850, diskSize: 150,
    })]]);
    expect(cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'diskSpillover')).toBeUndefined();
  });

  it('emits no diskSpillover finding just below the 0.15 diskRatio tier', () => {
    const rddInfo = new Map([[1, makeRdd(1, {
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 860, diskSize: 140, // 0.14
    })]]);
    expect(cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'diskSpillover')).toBeUndefined();
  });

  it('never flags DISK_ONLY storage for disk spillover regardless of diskSize', () => {
    const rddInfo = new Map([[1, makeRdd(1, {
      storageLevel: { useMemory: false, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 0, diskSize: 999999,
    })]]);
    expect(cacheFindings(makeApp({ rddInfo }))).toEqual([]);
  });

  it('never flags an unpersisted RDD (useMemory and useDisk both false)', () => {
    const rddInfo = new Map([[1, makeRdd(1, {
      storageLevel: { useMemory: false, useDisk: false, deserialized: false, replication: 1 },
    })]]);
    expect(cacheFindings(makeApp({ rddInfo }))).toEqual([]);
  });

  it('never flags an RDD with numCachedPartitions === 0', () => {
    const rddInfo = new Map([[1, makeRdd(1, { numCachedPartitions: 0 })]]);
    expect(cacheFindings(makeApp({ rddInfo }))).toEqual([]);
  });

  it('emits both partialCache and diskSpillover findings for the same RDD when both tiers are crossed', () => {
    const rddInfo = new Map([[7, makeRdd(7, {
      name: 'orders_cached',
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      numPartitions: 100, numCachedPartitions: 40, // 0.40 < 0.50 => warning partialCache
      memorySize: 290, diskSize: 710, // 0.71 > 0.40 => warning diskSpillover
    })]]);
    const forRdd = cacheFindings(makeApp({ rddInfo })).filter((f) => f.rddId === 7);
    expect(forRdd).toHaveLength(2);
    expect(forRdd.map((f) => f.variant).sort()).toEqual(['diskSpillover', 'partialCache']);
    expect(forRdd.every((f) => f.impactBand === 'warning')).toBe(true);
  });

  it('carries rddId, rddName, high confidence (100 partitions is a large, stable sample), and instance-derived partialCache recommendation text', () => {
    const rddInfo = new Map([[3, makeRdd(3, {
      name: 'orders_cached',
      numPartitions: 100, numCachedPartitions: 62, // 0.62
    })]]);
    const partial = cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'partialCache');
    expect(partial.rddId).toBe(3);
    expect(partial.rddName).toBe('orders_cached');
    expect(partial.confidence).toBe('high');
    expect(partial.validationRequired).toMatch(/Storage tab/);
    expect(partial.recommendation).toBe(
      'RDD orders_cached is 38% evicted from cache (62% of partitions cached). Increase executor memory or reduce the cached dataset size.',
    );
  });

  it('confidence scales with numPartitions (sample size), not a flat medium, for both variants', () => {
    // Old logic hardcoded 'medium' regardless of sample size; this would have failed under it.
    const tiny = new Map([[1, makeRdd(1, { numPartitions: 4, numCachedPartitions: 1 })]]); // 0.25, <10 partitions
    const mid = new Map([[2, makeRdd(2, { numPartitions: 20, numCachedPartitions: 5 })]]); // 0.25, 10-49 partitions
    const large = new Map([[3, makeRdd(3, { numPartitions: 80, numCachedPartitions: 20 })]]); // 0.25, >=50 partitions

    expect(cacheFindings(makeApp({ rddInfo: tiny })).find((f) => f.variant === 'partialCache').confidence).toBe('low');
    expect(cacheFindings(makeApp({ rddInfo: mid })).find((f) => f.variant === 'partialCache').confidence).toBe('medium');
    expect(cacheFindings(makeApp({ rddInfo: large })).find((f) => f.variant === 'partialCache').confidence).toBe('high');

    const tinySpill = new Map([[4, makeRdd(4, {
      numPartitions: 4,
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 300, diskSize: 700,
    })]]);
    const largeSpill = new Map([[5, makeRdd(5, {
      numPartitions: 80,
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 300, diskSize: 700,
    })]]);
    expect(cacheFindings(makeApp({ rddInfo: tinySpill })).find((f) => f.variant === 'diskSpillover').confidence).toBe('low');
    expect(cacheFindings(makeApp({ rddInfo: largeSpill })).find((f) => f.variant === 'diskSpillover').confidence).toBe('high');
  });

  it('carries the instance-derived diskSpillover recommendation text', () => {
    const rddInfo = new Map([[9, makeRdd(9, {
      name: 'orders_cached',
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      memorySize: 290, diskSize: 710, // 0.71
    })]]);
    const spill = cacheFindings(makeApp({ rddInfo })).find((f) => f.variant === 'diskSpillover');
    expect(spill.recommendation).toBe(
      'RDD orders_cached is 71% spilled to disk despite requesting MEMORY_AND_DISK. Executor memory may be too small for this cached dataset.',
    );
  });

  it('attaches memorySize/diskSize/numCachedPartitions/numPartitions from the source rdd object', () => {
    const rddInfo = new Map([[7, makeRdd(7, {
      name: 'orders_cached',
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      numPartitions: 100, numCachedPartitions: 40, // 0.40 < 0.50 => warning partialCache
      memorySize: 290, diskSize: 710, // 0.71 > 0.40 => warning diskSpillover
    })]]);
    const forRdd = cacheFindings(makeApp({ rddInfo })).filter((f) => f.rddId === 7);
    expect(forRdd).toHaveLength(2); // both partialCache and diskSpillover branches
    for (const finding of forRdd) {
      expect(typeof finding.memorySize).toBe('number');
      expect(typeof finding.diskSize).toBe('number');
      expect(typeof finding.numCachedPartitions).toBe('number');
      expect(typeof finding.numPartitions).toBe('number');
      expect(finding.memorySize).toBe(290);
      expect(finding.diskSize).toBe(710);
      expect(finding.numCachedPartitions).toBe(40);
      expect(finding.numPartitions).toBe(100);
    }
  });
});

describe('analyze, coreLocality detector', () => {
  it('returns no finding when total tasks are below thresholds.minTasks (50)', () => {
    const stages = new Map([[1, makeStage({ localityStats: [{ locality: 'ANY', count: 40 }] })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find((b) => b.type === 'coreLocality')).toBeUndefined();
  });

  it('returns no finding when the non-local ratio is below thresholds.warnRatio (0.15) even with enough tasks', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 90 },
        { locality: 'ANY', count: 10 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find((b) => b.type === 'coreLocality')).toBeUndefined();
  });

  it('emits a warning finding in the warn band (ratio >= 0.15, < 0.35)', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 80 },
        { locality: 'ANY', count: 20 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const finding = catalog.find((b) => b.type === 'coreLocality');
    expect(finding).toBeTruthy();
    expect(finding.impactBand).toBe('warning');
    expect(finding.metric).toBe('nonLocalRatio');
    expect(finding.value).toBe(20);
    expect(finding.stageId).toBeNull();
    expect(finding.confidence).toBe('low');
    expect(finding.validationRequired).toBeTruthy();
  });

  it('emits a critical finding at/above thresholds.critRatio (0.35)', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 60 },
        { locality: 'ANY', count: 40 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const finding = catalog.find((b) => b.type === 'coreLocality');
    expect(finding.impactBand).toBe('critical');
    expect(finding.value).toBe(40);
    // Ratio alone would be 'high' (>= critRatio), but the 100-task sample is still below
    // minTasks*4 (200): confidence reports the weaker of the two signals, not the ratio alone.
    expect(finding.confidence).toBe('medium');
  });

  it('marks coreLocality confidence high when both the ratio and the task sample are large', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 180 },
        { locality: 'ANY', count: 120 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const finding = catalog.find((b) => b.type === 'coreLocality');
    expect(finding.value).toBe(40);
    expect(finding.confidence).toBe('high');
  });

  it('never counts NO_PREF toward the numerator (shuffle-heavy stage with no real locality problem)', () => {
    const stages = new Map([[1, makeStage({ localityStats: [{ locality: 'NO_PREF', count: 100 }] })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find((b) => b.type === 'coreLocality')).toBeUndefined();
  });

  // Boundary-exact cases at the literal thresholds (minTasks 50, warnRatio 0.15, critRatio 0.35); the tests above use round numbers, never the cutoffs.
  it('returns no finding at totalTasks one below minTasks (49)', () => {
    const stages = new Map([[1, makeStage({ localityStats: [{ locality: 'ANY', count: 49 }] })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find((b) => b.type === 'coreLocality')).toBeUndefined();
  });

  it('emits a finding at totalTasks exactly at minTasks (50)', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 42 },
        { locality: 'ANY', count: 8 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const finding = catalog.find((b) => b.type === 'coreLocality');
    expect(finding).toBeTruthy();
    expect(finding.value).toBe(16);
  });

  it('returns no finding at ratio just below warnRatio (0.14)', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 86 },
        { locality: 'ANY', count: 14 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    expect(catalog.find((b) => b.type === 'coreLocality')).toBeUndefined();
  });

  it('emits a warning finding at ratio exactly at warnRatio (0.15)', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 85 },
        { locality: 'ANY', count: 15 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const finding = catalog.find((b) => b.type === 'coreLocality');
    expect(finding).toBeTruthy();
    expect(finding.impactBand).toBe('warning');
    expect(finding.value).toBe(15);
  });

  it('stays a warning finding at ratio just below critRatio (0.34)', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 66 },
        { locality: 'ANY', count: 34 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const finding = catalog.find((b) => b.type === 'coreLocality');
    expect(finding).toBeTruthy();
    expect(finding.impactBand).toBe('warning');
    expect(finding.value).toBe(34);
  });

  it('emits a critical finding at ratio exactly at critRatio (0.35)', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 65 },
        { locality: 'ANY', count: 35 },
      ],
    })]]);
    const catalog = analyze(makeApp(), stages, [], []);
    const finding = catalog.find((b) => b.type === 'coreLocality');
    expect(finding).toBeTruthy();
    expect(finding.impactBand).toBe('critical');
    expect(finding.value).toBe(35);
  });
});

describe('analyze, autoscaling churn detector (short-lived executors)', () => {
  // Builds executorsAdded/removed pairs; removedAt === null means still alive at app.endTime.
  function addedAndRemoved(pairs) {
    const added = [];
    const removed = [];
    pairs.forEach((p, i) => {
      const executorId = String(i + 1);
      added.push({ executorId, timestamp: p.addedAt, totalCores: 1 });
      if (p.removedAt != null) removed.push({ executorId, timestamp: p.removedAt });
    });
    return { added, removed };
  }

  it('emits no finding when app.endTime is missing (truncated/still-running log)', () => {
    const app = makeApp({ startTime: 0, endTime: undefined });
    const { added, removed } = addedAndRemoved([
      { addedAt: 0, removedAt: 60_000 }, { addedAt: 0, removedAt: 60_000 },
      { addedAt: 0, removedAt: 60_000 }, { addedAt: 0, removedAt: 60_000 },
      { addedAt: 0, removedAt: 60_000 },
    ]);
    const catalog = analyze(app, new Map(), added, removed);
    expect(catalog.find(b => b.type === 'autoscalingChurn')).toBeUndefined();
  });

  it('does not throw when app is null (ApplicationStart never parsed)', () => {
    const { added, removed } = addedAndRemoved([
      { addedAt: 0, removedAt: 60_000 }, { addedAt: 0, removedAt: 60_000 },
      { addedAt: 0, removedAt: 60_000 }, { addedAt: 0, removedAt: 60_000 },
      { addedAt: 0, removedAt: 60_000 },
    ]);
    const catalog = analyze(null, new Map(), added, removed);
    expect(catalog.find(b => b.type === 'autoscalingChurn')).toBeUndefined();
  });

  it('emits no finding below minExecutors (sample-size guard)', () => {
    const app = makeApp({ startTime: 0, endTime: 600_000 });
    // 3 executors, all short-lived (100%) but below the 5-executor floor.
    const { added, removed } = addedAndRemoved([
      { addedAt: 0, removedAt: 1000 }, { addedAt: 0, removedAt: 1000 }, { addedAt: 0, removedAt: 1000 },
    ]);
    const catalog = analyze(app, new Map(), added, removed);
    expect(catalog.find(b => b.type === 'autoscalingChurn')).toBeUndefined();
  });

  it('emits no finding when all executors are long-lived', () => {
    const app = makeApp({ startTime: 0, endTime: 600_000 });
    const { added, removed } = addedAndRemoved(
      Array.from({ length: 5 }, () => ({ addedAt: 0, removedAt: 600_000 })),
    );
    const catalog = analyze(app, new Map(), added, removed);
    expect(catalog.find(b => b.type === 'autoscalingChurn')).toBeUndefined();
  });

  it('emits a warning finding just over the 30% short-lived threshold', () => {
    const app = makeApp({ startTime: 0, endTime: 600_000 });
    // 100 executors, 31 short-lived (60s < 2min threshold) => 31% > 30%, <= 60%.
    const pairs = [
      ...Array.from({ length: 31 }, () => ({ addedAt: 0, removedAt: 60_000 })),
      ...Array.from({ length: 69 }, () => ({ addedAt: 0, removedAt: 600_000 })),
    ];
    const { added, removed } = addedAndRemoved(pairs);
    const catalog = analyze(app, new Map(), added, removed);
    const finding = catalog.find(b => b.type === 'autoscalingChurn');
    expect(finding).toBeTruthy();
    expect(finding.impactBand).toBe('warning');
    expect(finding.value).toBe(31);
    expect(finding.metric).toBe('shortLivedExecutorPct');
    expect(finding.confidence).toBe('low');
    expect(finding.stageId).toBeNull();
  });

  it('marks autoscalingChurn confidence medium between 1.5x warningPct and criticalPct', () => {
    const app = makeApp({ startTime: 0, endTime: 600_000 });
    const pairs = [
      ...Array.from({ length: 50 }, () => ({ addedAt: 0, removedAt: 60_000 })),
      ...Array.from({ length: 50 }, () => ({ addedAt: 0, removedAt: 600_000 })),
    ];
    const { added, removed } = addedAndRemoved(pairs);
    const catalog = analyze(app, new Map(), added, removed);
    const finding = catalog.find(b => b.type === 'autoscalingChurn');
    expect(finding.value).toBe(50);
    expect(finding.confidence).toBe('medium');
  });

  it('emits a critical finding just over the 60% short-lived threshold', () => {
    const app = makeApp({ startTime: 0, endTime: 600_000 });
    // 100 executors, 61 short-lived => 61% > 60%.
    const pairs = [
      ...Array.from({ length: 61 }, () => ({ addedAt: 0, removedAt: 60_000 })),
      ...Array.from({ length: 39 }, () => ({ addedAt: 0, removedAt: 600_000 })),
    ];
    const { added, removed } = addedAndRemoved(pairs);
    const catalog = analyze(app, new Map(), added, removed);
    const finding = catalog.find(b => b.type === 'autoscalingChurn');
    expect(finding).toBeTruthy();
    expect(finding.impactBand).toBe('critical');
    expect(finding.value).toBe(61);
    // 61% clears criticalPct (60%) outright: the high-confidence bar.
    expect(finding.confidence).toBe('high');
  });

  it('does not fire at all at exactly the 30% boundary (thresholds are exclusive)', () => {
    const app = makeApp({ startTime: 0, endTime: 600_000 });
    const pairs = [
      ...Array.from({ length: 30 }, () => ({ addedAt: 0, removedAt: 60_000 })),
      ...Array.from({ length: 70 }, () => ({ addedAt: 0, removedAt: 600_000 })),
    ];
    const { added, removed } = addedAndRemoved(pairs);
    const catalog = analyze(app, new Map(), added, removed);
    expect(catalog.find(b => b.type === 'autoscalingChurn')).toBeUndefined();
  });

  it('stays warning (does not escalate to critical) at exactly the 60% boundary', () => {
    const app = makeApp({ startTime: 0, endTime: 600_000 });
    const pairs = [
      ...Array.from({ length: 60 }, () => ({ addedAt: 0, removedAt: 60_000 })),
      ...Array.from({ length: 40 }, () => ({ addedAt: 0, removedAt: 600_000 })),
    ];
    const { added, removed } = addedAndRemoved(pairs);
    const catalog = analyze(app, new Map(), added, removed);
    const finding = catalog.find(b => b.type === 'autoscalingChurn');
    expect(finding).toBeTruthy();
    expect(finding.impactBand).toBe('warning');
  });
});

describe('analyze, impact estimator: executor-churn ceiling regression', () => {
  // Sequential single-executor replacement: at most 2 cores ever alive at once (2 cores × 10s = 20000ms).
  // A cumulative sum would total 6, understating the ceiling and letting gc claim wall-clock a saturated stage has no room to give up.
  const churnedApp = makeApp({ startTime: 0, endTime: 10000, resources: { executor: { cores: 2 } } });
  const churnedAdded = [
    { executorId: '1', timestamp: 0, totalCores: 2 },
    { executorId: '2', timestamp: 1000, totalCores: 2 },
    { executorId: '3', timestamp: 2000, totalCores: 2 },
  ];
  const churnedRemoved = [
    { executorId: '1', timestamp: 1000 },
    { executorId: '2', timestamp: 2000 },
  ];
  const churnedStage = makeStage({
    submittedAt: 0, completedAt: 10000, executorRunTime: 20000, jvmGCTime: 15000,
    gcPct: 50, taskDurationMax: 100, taskDurationP50: 100,
  });

  it('does not let executor churn inflate a stage-scoped finding claimed wall-clock', () => {
    const catalog = analyze(churnedApp, new Map([[1, churnedStage]]), churnedAdded, churnedRemoved);
    const gc = catalog.find((b) => b.type === 'gc' && b.stageId === 1);
    expect(gc).toBeTruthy();
    // Saturated at true peak capacity (2 cores) for the whole window, so no slack to reclaim.
    expect(gc.impactEstimate.wallClock).toEqual({ low: 0, high: 0 });
  });
});

describe("analyze: recommendation text interpolates the finding's own numbers", () => {
  it('skew: includes the measured ratio', () => {
    const stages = new Map([[1, makeStage({ taskDurationP50: 100, taskDurationP95: 350 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'skew');
    expect(b.recommendation).toContain(`${b.value}×`);
  });

  it('stageShape (taskStageSkew): includes the ratio', () => {
    const execs = (n) => Array.from({ length: n }, (_, i) => ({ executorId: `e${i}`, taskCount: 1, totalDuration: 0 }));
    const stage = makeStage({ id: 1, submittedAt: 0, completedAt: 1000, taskDurationMax: 4000, executorStats: execs(2) });
    const found = analyze(makeApp(), new Map([[1, stage]]), [], []).find(b => b.rule === 'taskStageSkew');
    expect(found.recommendation).toContain(`${found.value}×`);
  });

  it('shuffle: includes the shuffled byte figure', () => {
    const stages = new Map([[1, makeStage({ shuffleReadBytes: 600 * 1024 * 1024 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'shuffle');
    expect(b.recommendation).toContain(formatBytes(b.value));
  });

  it('partitionSizing (shufflePartitionSkew): includes the larger/median byte figures', () => {
    const MiB = 1024 * 1024;
    const stages = new Map([[1, makeStage({ shuffleReadP50: 10 * MiB, shuffleReadMax: 300 * MiB, shuffleReadBytes: 400 * MiB, taskCount: 50 })]]);
    const found = analyze(makeApp(), stages, [], []).find(b => b.type === 'partitionSizing' && b.rule === 'shufflePartitionSkew');
    expect(found.recommendation).toContain(formatBytes(300 * MiB));
    expect(found.recommendation).toContain(formatBytes(10 * MiB));
  });

  it('partitionSizing (shufflePartitionSkew): p50 of 0 avoids a divide-by-zero "Infinity×"', () => {
    const MiB = 1024 * 1024;
    const stages = new Map([[1, makeStage({ shuffleReadP50: 0, shuffleReadMax: 300 * MiB, shuffleReadBytes: 400 * MiB, taskCount: 50 })]]);
    const found = analyze(makeApp(), stages, [], []).find(b => b.type === 'partitionSizing' && b.rule === 'shufflePartitionSkew');
    expect(found.recommendation).not.toContain('Infinity');
    expect(found.recommendation).toContain(formatBytes(300 * MiB));
    expect(found.recommendation).toContain('effectively empty');
  });

  it("partitionSizing (maxPartitionTooBig): includes the oversized partition's byte figure", () => {
    const MiB = 1024 * 1024;
    const stages = new Map([[1, makeStage({ shuffleReadP50: 10 * MiB, shuffleReadMax: 6 * 1024 * MiB, shuffleReadBytes: 7 * 1024 * MiB, taskCount: 50 })]]);
    const found = analyze(makeApp(), stages, [], []).find(b => b.type === 'partitionSizing' && b.rule === 'maxPartitionTooBig');
    expect(found.recommendation).toContain(formatBytes(6 * 1024 * MiB));
  });

  it('spill (skew-driven): includes the spilled byte figure', () => {
    const stages = new Map([[1, makeStage({ memoryBytesSpilled: 2 * 1024 * 1024 * 1024, spillClassification: 'skew' })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'spill');
    expect(b.recommendation).toContain(formatBytes(2 * 1024 * 1024 * 1024));
  });

  it('spill (volume-driven): includes the spilled byte figure', () => {
    const stages = new Map([[1, makeStage({ memoryBytesSpilled: 500 * 1024 * 1024, spillClassification: 'volume' })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'spill');
    expect(b.recommendation).toContain(formatBytes(500 * 1024 * 1024));
  });

  it('gc (high): includes the measured GC percentage', () => {
    const stages = new Map([[1, makeStage({ gcPct: 25, executorRunTime: 60000 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'gc' && x.direction !== 'low');
    expect(b.recommendation).toContain(`${b.value}%`);
  });

  it('gc (low): includes the measured GC percentage', () => {
    const stages = new Map([[1, makeStage({ gcPct: 3, executorRunTime: 60000 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'gc' && x.direction === 'low');
    expect(b.recommendation).toContain(`${b.value}%`);
  });

  it('stageSlowness: includes the stage duration in minutes', () => {
    const min = 60000;
    const slow = makeStage({ id: 1, executorRunTime: 40 * min * 4, executorStats: Array.from({ length: 4 }, (_, i) => ({ executorId: `e${i}`, taskCount: 1, totalDuration: 0 })), hostStats: [], submittedAt: 0, completedAt: 40 * min });
    const b = analyze(makeApp(), new Map([[1, slow]]), [], []).find(x => x.type === 'stageSlowness');
    expect(b.recommendation).toContain(`${b.value} minutes`);
  });

  it('stageFailed: value carries the raw reason, recommendation stays reason-free', () => {
    const stages = new Map([[1, makeStage({ stageFailureReason: 'Job aborted due to stage failure', failedTasks: 0 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'stageFailed');
    expect(b.value).toBe('Job aborted due to stage failure');
    expect(b.recommendation).not.toContain('Job aborted due to stage failure');
    expect(b.recommendation).toContain('Inspect the driver log');
  });

  it('failures: includes the failure rate and dominant reason', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, failedTasks: 25, failureReasons: [{ reason: 'FetchFailed', count: 25 }] })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'failures');
    expect(b.recommendation).toContain(`${b.value}%`);
    expect(b.recommendation).toContain('FetchFailed');
  });

  it('straggler: includes the straggler share', () => {
    const stages = new Map([[1, makeStage({ taskCount: 100, speculativeTasks: 0, stragglerCount: 8, taskDurationMax: 300 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'straggler');
    expect(b.recommendation).toContain(`${b.value}%`);
  });

  it('speculationWaste: includes the wasted time', () => {
    const stages = new Map([[1, makeStage({ speculationWastedAttempts: 5, speculationWasteMs: 90000 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'speculationWaste');
    expect(b.recommendation).toContain(`${Math.round(b.value / 1000)}s`);
  });

  it('retryWaste: includes the wasted time and attempt count', () => {
    const stages = new Map([[1, makeStage({ wastedAttempts: 4, retryWasteMs: 360000 })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'retryWaste');
    expect(b.recommendation).toContain(`${Math.round(b.value / 1000)}s`);
    expect(b.recommendation).toContain('4 attempts');
  });

  it('coldStart: includes the startup gap in seconds', () => {
    const app = makeApp({ startTime: 1000, endTime: 100000 });
    const stages = new Map([[1, makeStage({ submittedAt: 2000 })]]);
    const added = [{ executorId: '1', timestamp: 42000, totalCores: 4 }];
    const b = analyze(app, stages, added, []).find(x => x.type === 'coldStart');
    expect(b.recommendation).toContain(`${b.value}s`);
  });

  it('utilization: includes the measured utilization percentage', () => {
    const app = makeApp({ startTime: 1000, endTime: 11000, resources: { executor: { cores: 4 } } });
    const stages = new Map([[1, makeStage({ executorRunTime: 100000, executorCpuTime: 16000000000 })]]);
    const added = [
      { executorId: '1', timestamp: 1000, totalCores: 4 },
      { executorId: '2', timestamp: 1000, totalCores: 4 },
    ];
    const removed = [{ executorId: '2', timestamp: 2000 }];
    const b = analyze(app, stages, added, removed).find(x => x.type === 'utilization');
    expect(b.recommendation).toContain(`${b.value}%`);
  });

  it('memoryUtilization (idleCores): includes the idle-core-time percentage', () => {
    const raBusy = (busyCoreMs, peak) => ({ coreHistogram: [], busyCoreMs, peakConcurrentCores: peak, perStage: {} });
    const app = makeApp({ startTime: 0, endTime: 10000, resources: { executor: { cores: 4, memoryMB: 4096 } } });
    const added = [{ executorId: '1', timestamp: 0, totalCores: 4 }, { executorId: '2', timestamp: 0, totalCores: 4 }];
    const catalog = analyze(app, new Map([[1, makeStage()]]), added, [], new Map(), new Map(), raBusy(20000, 8));
    const b = catalog.find(x => x.type === 'memoryUtilization' && x.variant === 'idleCores');
    expect(b.recommendation).toContain(`${b.value}%`);
  });

  it('memoryUtilization (wasteModel): includes the wasted MB-seconds figure', () => {
    const raBusy = (busyCoreMs, peak) => ({ coreHistogram: [], busyCoreMs, peakConcurrentCores: peak, perStage: {} });
    const app = makeApp({ startTime: 0, endTime: 3600000, resources: { executor: { cores: 4, memoryMB: 4096 } } });
    const added = Array.from({ length: 4 }, (_, i) => ({ executorId: String(i), timestamp: 0, totalCores: 4 }));
    const stage = makeStage({ executorRunTime: 1000 });
    const catalog = analyze(app, new Map([[1, stage]]), added, [], new Map(), new Map(), raBusy(0, 0));
    const b = catalog.find(x => x.type === 'memoryUtilization' && x.variant === 'wasteModel');
    expect(b.recommendation).toContain(b.value.toLocaleString('en-US'));
  });

  it('coreLocality: includes the non-local percentage and task count', () => {
    const stages = new Map([[1, makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 80 },
        { locality: 'ANY', count: 20 },
      ],
    })]]);
    const b = analyze(makeApp(), stages, [], []).find(x => x.type === 'coreLocality');
    expect(b.recommendation).toContain(`${b.value}%`);
    expect(b.recommendation).toContain(`(${b.nonLocalTaskCount})`);
  });

  it('jobFailureRate: includes the failed/total job counts', () => {
    const jobs = new Map();
    for (let i = 0; i < 9; i++) jobs.set(i, { id: i, submissionTime: 0, stageIds: [], result: 'JobSucceeded', succeeded: true, exception: null, completionTime: 100 });
    jobs.set(9, { id: 9, submissionTime: 0, stageIds: [], result: 'JobFailed', succeeded: false, exception: null, completionTime: 100 });
    const b = analyze(makeApp(), new Map(), [], [], jobs).find(x => x.type === 'jobFailureRate');
    expect(b.recommendation).toContain(`${b.failedJobs} of ${b.totalJobs} jobs`);
  });

  it('configAudit (serializer): includes the current serializer', () => {
    const app = { config: { 'spark.executor.memory': '4g' }, resources: { executor: {}, driver: {}, dynamicAllocationEnabled: null, shuffleServiceEnabled: null, serializer: null } };
    const f = auditConfig(app).find(x => x.property === 'spark.serializer');
    expect(f.recommendation).toContain('the default JavaSerializer');
  });
});
