import { describe, it, expect } from 'vitest';
import { estimateImpact } from '../src/impact-estimator.js';
import { computeOccupancy } from '../src/occupancy.js';
import { analyze } from '../src/analyzer.js';
import { buildEvidenceReport } from '../src/evidence-report.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

function estimate(findings, stages, totalCores) {
  estimateImpact(findings, { stages, totalCores, occupancy: computeOccupancy(stages, totalCores) });
  return findings.map((f) => f.impactEstimate);
}

const retry = () => ({ type: 'retryWaste', stageId: 0, metric: 'retryWasteMs', value: 1200, impactBand: 'warning' });
const soloStage = () => new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [], retryWasteMs: 1200 }]]);
// 100 tasks, 10s of task run time over a 5s window: 2 cores busy on average.
const tiny = () => ({ type: 'tinyTask', stageId: 0, value: 50, impactBand: 'info' });
const twoCoreStage = (extra = {}) => new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [], taskCount: 100, executorRunTime: 10000, ...extra }]]);

describe('impact estimate coreTimeMs', () => {
  it('takes a cross-task executor-time figure as measured, whatever the run\'s cores', () => {
    const [est] = estimate([retry()], soloStage(), 8);
    expect(est.wallClock).toEqual({ low: 1200, high: 1200 });
    expect(est.coreTimeMs).toEqual({ low: 1200, high: 1200 });
    expect(estimate([retry()], soloStage(), 0)[0].coreTimeMs).toEqual({ low: 1200, high: 1200 });
  });

  it('gives retried attempts and GC the same figure for the same executor time', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [], retryWasteMs: 1200 }],
      [1, { id: 1, submittedAt: 0, completedAt: 5000, parentIds: [], executorRunTime: 10000, jvmGCTime: 1200 }],
    ]);
    const gc = { type: 'gc', stageId: 1, direction: 'high', value: 12, impactBand: 'warning' };
    const [r, g] = estimate([retry(), gc], stages, 8);
    expect(g.coreTimeMs).toEqual({ low: 1200, high: 1200 });
    expect(r.coreTimeMs).toEqual(g.coreTimeMs);
  });

  it('takes speculation\'s discarded executor time as measured', () => {
    const stages = new Map([[0, { id: 0, submittedAt: 0, completedAt: 5000, parentIds: [], speculationWasteMs: 900 }]]);
    const [est] = estimate([{ type: 'speculationWaste', stageId: 0, value: 900, impactBand: 'warning' }], stages, 8);
    expect(est.coreTimeMs).toEqual({ low: 900, high: 900 });
  });

  it('multiplies a wall-clock-only claim by its stage\'s busy cores, not the run\'s peak cores', () => {
    for (const totalCores of [8, 64]) {
      const [est] = estimate([tiny()], twoCoreStage(), totalCores);
      expect(est.rawWaste.unit).toBe('ms');
      expect(est.wallClock.high).toBeGreaterThan(0);
      expect(est.coreTimeMs).toEqual({ low: est.wallClock.low * 2, high: est.wallClock.high * 2 });
    }
  });

  it('reads a queued stage\'s busy cores over the time its tasks ran, not the time it sat open', () => {
    // Open 2491s, tasks running for 60s of it on 8 cores.
    const stage = { id: 0, submittedAt: 0, completedAt: 2_491_000, taskActiveMs: 60_000, parentIds: [], taskCount: 100, executorRunTime: 480_000 };
    const [est] = estimate([tiny()], new Map([[0, stage]]), 8);
    expect(est.wallClock.high).toBeGreaterThan(0);
    expect(est.coreTimeMs.low).toBeCloseTo(est.wallClock.low * 8);
    expect(est.coreTimeMs.high).toBeCloseTo(est.wallClock.high * 8);
  });

  it('is null, not 0, for a wall-clock-only claim whose stage recorded no task run time', () => {
    const [est] = estimate([tiny()], twoCoreStage({ executorRunTime: 0 }), 8);
    expect(est.wallClock.high).toBeGreaterThan(0);
    expect(est.coreTimeMs).toBeNull();
  });

  it('takes a core-time raw figure as measured, even with no executor cores in the log', () => {
    const stages = new Map([[0, makeStage({ id: 0, taskCount: 2, executorRunTime: 4000, submittedAt: 0, completedAt: 4000, peakConcurrentTasks: 2, taskDurationMax: 2000 })]]);
    const finding = { type: 'coreLocality', stageId: null, value: 50, nonLocalTaskCount: 100, impactBand: 'info' };
    const [est] = estimate([finding], stages, 0);
    expect(est.rawWaste).toEqual({ value: 2000, unit: 'coreMs' });
    expect(est.coreTimeMs).toEqual({ low: 2000, high: 2000 });
  });

  it('converts core-hours, and leaves executor-hour and job-hour figures null', () => {
    const utilization = { type: 'utilization', stageId: null, value: 25, utilizationFraction: 0.25, appDurationMs: 3_600_000, totalCores: 4, impactBand: 'info' };
    const churn = { type: 'autoscalingChurn', stageId: null, value: 50, shortLivedExecutorCount: 10, impactBand: 'warning' };
    const jobs = { type: 'jobFailureRate', stageId: null, value: 50, failedJobs: 2, avgJobDurationMs: 600_000, impactBand: 'warning' };
    const [u, c, j] = estimate([utilization, churn, jobs], new Map(), 4);
    expect(u.coreTimeMs).toEqual({ low: 0.75 * 4 * 3_600_000, high: 0.75 * 4 * 3_600_000 });
    expect(c.rawWaste.unit).toBe('coreHours');
    expect(c.coreTimeMs).toBeNull();
    expect(j.rawWaste.unit).toBe('coreHours');
    expect(j.coreTimeMs).toBeNull();
  });

  it('is null for byte and memory figures and for an estimate with no model', () => {
    const shuffle = { type: 'shuffle', stageId: 0, value: 1, impactBand: 'info' };
    const stages = new Map([[0, makeStage({ id: 0, shuffleReadBytes: 500 * 1024 * 1024, submittedAt: 0, completedAt: 0 })]]);
    const [s] = estimate([shuffle], stages, 8);
    expect(s.wallClock).toBeNull();
    expect(s.coreTimeMs).toBeNull();
  });

  it('does not depend on executorCpuTime', () => {
    const withCpu = twoCoreStage({ executorCpuTime: 123 });
    expect(estimate([tiny()], withCpu, 8)[0].coreTimeMs).toEqual(estimate([tiny()], twoCoreStage(), 8)[0].coreTimeMs);
  });
});

describe('coreTimeMs in the evidence report', () => {
  // 40s of task run time over a 20s stage: 2 busy cores.
  const slowStage = () => makeStage({ id: 1, taskCount: 100, taskDurationP50: 100, taskDurationP95: 600, taskDurationMax: 4000, completedAt: 20000, executorRunTime: 40000 });
  const fixture = (executors) => ({
    app: makeApp({ endTime: 20000 }),
    stages: new Map([[1, slowStage()]]),
    executors: { added: executors, removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null,
  });
  const wallClockOnlyRows = (json) => json.findings.filter((r) => r.impactEstimate?.wallClock && r.impactEstimate.rawWaste?.unit === 'ms');

  it('is the wall-clock claim times the stage\'s busy cores, with or without executor data', () => {
    const added = [{ executorId: '1', timestamp: 0, totalCores: 4 }, { executorId: '2', timestamp: 0, totalCores: 4 }];
    for (const executors of [[], added]) {
      const rows = wallClockOnlyRows(buildEvidenceReport(fixture(executors)).json);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const { wallClock, coreTimeMs } = row.impactEstimate;
        expect(coreTimeMs, row.type).toEqual({ low: wallClock.low * 2, high: wallClock.high * 2 });
      }
    }
  });

  it('stays null for a cut-off log', () => {
    const findings = analyze(makeApp({ endTime: null }), new Map(), [], [], new Map());
    const incomplete = findings.find((f) => f.type === 'incompleteRun');
    expect(incomplete.impactEstimate.coreTimeMs).toBeNull();
  });
});
