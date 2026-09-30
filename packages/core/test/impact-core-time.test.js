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

describe('impact estimate coreTimeMs', () => {
  it('multiplies a wall-clock claim by the executor cores the run held', () => {
    const [est] = estimate([retry()], soloStage(), 8);
    expect(est.wallClock).toEqual({ low: 1200, high: 1200 });
    expect(est.coreTimeMs).toEqual({ low: 9600, high: 9600 });
  });

  it('carries a contended wall-clock range through as a core-time range', () => {
    const stages = new Map([
      [0, { id: 0, submittedAt: 0, completedAt: 50000, parentIds: [] }],
      [1, { id: 1, submittedAt: 0, completedAt: 3000, parentIds: [], retryWasteMs: 1200 }],
    ]);
    const [est] = estimate([{ ...retry(), stageId: 1 }], stages, 4);
    expect(est.coreTimeMs).toEqual({ low: 600 * 4, high: 1200 * 4 });
  });

  it('is null, not 0, when the log has no executor cores', () => {
    const [est] = estimate([retry()], soloStage(), 0);
    expect(est.wallClock.high).toBe(1200);
    expect(est.coreTimeMs).toBeNull();
  });

  it('takes a core-time raw figure as measured', () => {
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
    const withCpu = soloStage();
    withCpu.get(0).executorCpuTime = 123;
    expect(estimate([retry()], withCpu, 8)[0].coreTimeMs).toEqual(estimate([retry()], soloStage(), 8)[0].coreTimeMs);
  });
});

describe('coreTimeMs in the evidence report', () => {
  const slowStage = () => makeStage({ id: 1, taskCount: 100, taskDurationP50: 100, taskDurationP95: 600, taskDurationMax: 4000, completedAt: 20000, executorRunTime: 40000 });
  const fixture = (executors) => ({
    app: makeApp({ endTime: 20000 }),
    stages: new Map([[1, slowStage()]]),
    executors: { added: executors, removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null,
  });

  it('is null on every estimate of a log without executor data', () => {
    const { json } = buildEvidenceReport(fixture([]));
    const rows = json.findings.filter((r) => r.impactEstimate?.wallClock);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.impactEstimate.coreTimeMs, row.type).toBeNull();
  });

  it('is wall-clock times peak cores once the log has executors', () => {
    const added = [{ executorId: '1', timestamp: 0, totalCores: 4 }, { executorId: '2', timestamp: 0, totalCores: 4 }];
    const { json } = buildEvidenceReport(fixture(added));
    const rows = json.findings.filter((r) => r.impactEstimate?.wallClock);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const { wallClock, coreTimeMs } = row.impactEstimate;
      expect(coreTimeMs, row.type).toEqual({ low: wallClock.low * 8, high: wallClock.high * 8 });
    }
  });

  it('stays null for a cut-off log', () => {
    const findings = analyze(makeApp({ endTime: null }), new Map(), [], [], new Map());
    const incomplete = findings.find((f) => f.type === 'incompleteRun');
    expect(incomplete.impactEstimate.coreTimeMs).toBeNull();
  });
});
