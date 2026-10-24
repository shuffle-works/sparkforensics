import { describe, it, expect } from 'vitest';
import { estimateImpact } from '../src/impact-estimator.js';
import { computeOccupancy } from '../src/occupancy.js';
import { capCriticalByTaskTime, CRITICAL_MIN_TASK_TIME_SHARE } from '../src/impact-band.ts';
import { rankedRollup, rankStageCostMs } from '../src/recommendation-rollup.ts';
import { buildNextSteps } from '../src/run-verdict.ts';
import { analyze } from '../src/analyzer.js';
import { makeApp } from './fixtures/stage-app-fixtures.js';

const HOUR_MS = 3_600_000;

// A 30-minute stage of `taskHours` summed task time, spread over `executors` executors.
function stage(id, taskHours, extra = {}, executors = 1) {
  return {
    id, submittedAt: 0, completedAt: 30 * 60_000, parentIds: [], taskCount: 1000,
    executorStats: Array.from({ length: executors }, (_, i) => ({
      executorId: String(i), taskCount: 1000 / executors, totalDuration: (taskHours * HOUR_MS) / executors,
    })),
    ...extra,
  };
}

function finding(type, stageId, impactBand, stageTaskHours, wallClockMs = null) {
  return {
    type, stageId, impactBand, recommendation: `fix ${type}`,
    impactEstimate: {
      basis: wallClockMs == null ? 'resourceOnly' : 'serial',
      wallClock: wallClockMs == null ? null : { low: wallClockMs, high: wallClockMs },
      estimateMethod: 'modeled',
      ...(wallClockMs == null ? { rawWaste: { value: 1, unit: 'bytes' } } : {}),
      stageTaskMs: stageTaskHours * HOUR_MS,
    },
  };
}

describe('task-hour ranking: one axis for verdict steps and recommendations', () => {
  // A heavy stage with a modest wall-clock saving, two cheaper stages with larger wall-clock savings.
  const findings = [
    finding('skew', 1, 'warning', 3, 9 * 60_000),
    finding('shuffle', 2, 'warning', 20, 4 * 60_000),
    finding('spill', 3, 'warning', 400, 2 * 60_000),
  ];

  it('orders the steps by the stage task time, not the wall-clock saving', () => {
    expect(buildNextSteps(findings).map((step) => step.lead.type)).toEqual(['spill', 'shuffle', 'skew']);
  });

  it('gives the recommendations the same order as the steps', () => {
    const stages = new Map([1, 2, 3].map((id) => [id, stage(id, 1)]));
    const steps = buildNextSteps(findings).map((step) => step.lead.type);
    expect(rankedRollup(findings, stages).map((group) => group.type)).toEqual(steps);
  });

  it('ranks an info finding and an app-level finding after every warning on a stage with task time', () => {
    const appLevel = { type: 'utilization', impactBand: 'warning', recommendation: 'resize', impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 5, unit: 'coreHours' } } };
    const info = finding('gc', 4, 'info', 900, 60_000);
    const order = buildNextSteps([appLevel, info, ...findings]).map((step) => step.lead.type);
    expect(order.slice(0, 3)).toEqual(['spill', 'shuffle', 'skew']);
    expect(rankStageCostMs(info)).toBe(0);
  });
});

describe('task-hour ranking: a heavy spill stage against a cheap critical finding', () => {
  it('ranks the spill ahead of a critical slow host on a stage worth 0.4 task-hours', () => {
    const spill = finding('spill', 3, 'warning', 400, 20 * 60_000);
    const slowHost = finding('slowHost', 9, 'critical', 0.4);
    expect(buildNextSteps([slowHost, spill]).map((step) => step.lead.type)).toEqual(['spill', 'slowHost']);
    const stages = new Map([[3, stage(3, 1)], [9, stage(9, 1)]]);
    expect(rankedRollup([slowHost, spill], stages).map((group) => group.type)).toEqual(['spill', 'slowHost']);
  });

  it('files a group under its worst member band while the heavier stage leads it', () => {
    const cheapCritical = finding('skew', 1, 'critical', 5, 10 * 60_000);
    const heavyWarning = finding('skew', 2, 'warning', 40, 60_000);
    const stages = new Map([[1, stage(1, 5)], [2, stage(2, 40)]]);
    const [group] = rankedRollup([cheapCritical, heavyWarning], stages);
    expect(group.members[0]).toBe(heavyWarning);
    expect(group.band).toBe('critical');
  });
});

describe('capCriticalByTaskTime', () => {
  // 2,513 task-hours over the run; the stage under test carries 0.4 of them.
  const stages = new Map([[1, stage(1, 0.4)], [2, stage(2, 2512.6)]]);
  const slowHost = (stageId) => ({ ...finding('slowHost', stageId, 'critical', 0), impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' } });

  it('caps a critical finding on a stage under the minimum share', () => {
    const findings = [slowHost(1)];
    capCriticalByTaskTime(findings, stages);
    expect(findings[0].impactBand).toBe('warning');
  });

  it('keeps critical on a stage at or over the minimum share', () => {
    const findings = [slowHost(2)];
    capCriticalByTaskTime(findings, stages);
    expect(findings[0].impactBand).toBe('critical');
    expect(CRITICAL_MIN_TASK_TIME_SHARE).toBe(0.02);
  });

  it('keeps critical on a failure and on an oversized-partition safety signal', () => {
    const findings = [
      { ...slowHost(1), type: 'stageFailed' },
      { ...slowHost(1), type: 'partitionSizing', rule: 'maxPartitionTooBig' },
    ];
    capCriticalByTaskTime(findings, stages);
    expect(findings.map((f) => f.impactBand)).toEqual(['critical', 'critical']);
  });

  it('caps a finding graded critical from a wall-clock estimate the same way', () => {
    const timed = { ...slowHost(1), impactEstimate: { basis: 'serial', wallClock: { low: 1, high: 1 }, estimateMethod: 'modeled' } };
    const findings = [timed];
    capCriticalByTaskTime(findings, stages);
    expect(findings[0].impactBand).toBe('warning');
  });

  it('caps a sql-scope finding whose stageIds hold one cheap stage, but not one spanning several', () => {
    const sqlScope = (stageIds) => ({ ...slowHost(1), type: 'duplicatePlanSubtree', stageId: undefined, stageIds });
    const findings = [sqlScope([1]), sqlScope([1, 2])];
    capCriticalByTaskTime(findings, stages);
    expect(findings.map((f) => f.impactBand)).toEqual(['warning', 'critical']);
  });

  it('leaves an app-level finding and a run with no recorded task time alone', () => {
    const appLevel = { ...slowHost(1), stageId: null };
    const findings = [appLevel];
    capCriticalByTaskTime(findings, stages);
    expect(findings[0].impactBand).toBe('critical');
    const noTime = [slowHost(1)];
    capCriticalByTaskTime(noTime, new Map([[1, { id: 1 }]]));
    expect(noTime[0].impactBand).toBe('critical');
  });

  it('leaves a finding on a stage with no recorded task time alone in a run that has some', () => {
    const findings = [slowHost(3)];
    capCriticalByTaskTime(findings, new Map([...stages, [3, { id: 3 }]]));
    expect(findings[0].impactBand).toBe('critical');
  });
});

describe('spill impact estimate', () => {
  function spillEstimate(stageFields) {
    const stages = new Map([[0, stage(0, 422.5, stageFields, 255)]]);
    const findings = [{ type: 'spill', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, { stages, totalCores: 0, occupancy: computeOccupancy(stages, 0) });
    return findings[0].impactEstimate;
  }

  it('charges spill as serialization and sort CPU on top of the disk I/O time, up to the cap', () => {
    // 0.7 passes of the read bytes through disk: 50% each is 35% of the 30-minute stage.
    const stageFields = { shuffleReadBytes: 10e12, memoryBytesSpilled: 67.7e12, diskBytesSpilled: 7e12 };
    const diskOnly = (7e12 / (200_000_000 * 255)) * 1000;
    const est = spillEstimate(stageFields);
    expect(est.wallClock.high).toBeCloseTo(0.35 * 30 * 60_000 + diskOnly, 0);
    expect(est.assumptions).toContain('plus 35% of the stage\'s task time as serialization and sort CPU');
    const capped = spillEstimate({ ...stageFields, diskBytesSpilled: 20e12 });
    expect(capped.assumptions).toContain('plus 40% of the stage\'s task time as serialization and sort CPU');
    expect(est.assumptions).toContain('GC is not counted');
    expect(est.stageTaskMs).toBeCloseTo(422.5 * HOUR_MS, 0);
  });

  it('scales the CPU share with the spilled passes and states when it has no bytes to compare', () => {
    const light = spillEstimate({ shuffleReadBytes: 100e9, memoryBytesSpilled: 50e9, diskBytesSpilled: 10e9 });
    expect(light.wallClock.high).toBeCloseTo(30 * 60_000 * 0.05 + (10e9 / (200_000_000 * 255)) * 1000, 0);
    const noBase = spillEstimate({ memoryBytesSpilled: 50e9, diskBytesSpilled: 10e9 });
    expect(noBase.assumptions).toContain('serialization and sort CPU is not counted');
  });

  it('keeps the CPU share on a stage packed onto every core, whose core-work floor drops with it', () => {
    // 400 x 60 s tasks on 16 cores: the 25-minute stage is exactly its core work over every core.
    const packed = {
      completedAt: 25 * 60_000, executorRunTime: 400 * 60_000, taskDurationMax: 60_000,
      shuffleReadBytes: 100e9, memoryBytesSpilled: 400e9, diskBytesSpilled: 100e9,
    };
    const stages = new Map([[0, stage(0, 400 / 60, packed, 4)]]);
    const findings = [{ type: 'spill', stageId: 0, impactBand: 'warning' }];
    estimateImpact(findings, { stages, totalCores: 16, occupancy: computeOccupancy(stages, 16) });
    expect(findings[0].impactEstimate.wallClock.high).toBeCloseTo(0.4 * 25 * 60_000, 0);
  });
});

describe('task-hour ranking: plan findings on the execution-wide stage fallback', () => {
  const MB = 1024 * 1024;
  // One execution over two heavy stages; the write node either has stage coverage or none.
  function run(writeStageIds) {
    const write = {
      name: 'Execute InsertIntoHadoopFsRelationCommand', detail: '', children: [], stageIds: writeStageIds,
      metrics: [{ name: 'number of written files', value: 800, metricType: 'sum' }, { name: 'written output', value: 0.8 * MB, metricType: 'sum' }],
    };
    const planTree = { name: 'Project', detail: '', metrics: [], children: [write] };
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 30 * 60_000, stageIds: [1, 2], planTree }]]);
    const stages = new Map([1, 2].map((id) => [id, stage(id, 100, { sqlExecutionId: 1 })]));
    return analyze(makeApp(), stages, [], [], new Map(), sql).find((f) => f.type === 'smallFiles');
  }

  it('gives a smallFiles finding on the fallback no stage task time', () => {
    const smallFiles = run(undefined);
    expect(smallFiles.stageIds).toEqual([1, 2]);
    expect(smallFiles.impactEstimate.stageTaskMs).toBeUndefined();
    expect(rankStageCostMs(smallFiles)).toBe(0);
  });

  it('keeps the task time of the stage a plan node ran on', () => {
    expect(run([2]).impactEstimate.stageTaskMs).toBe(100 * HOUR_MS);
  });
});
