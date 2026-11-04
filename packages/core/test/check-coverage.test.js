import { describe, it, expect } from 'vitest';
import {
  checkCoverage, hasFinishedStage, INCOMPLETE_RUN_GAP, isCleanRun, NO_FINISHED_STAGE_GAP,
  PER_STAGE_CHECK_TYPES, verdictGaps,
} from '../src/check-coverage.ts';
import { isCaveat } from '../src/recommendation-rollup.ts';
import { makeTypedStage } from './fixtures/stage-app-fixtures.js';

const unfinished = new Map([[1, makeTypedStage({ id: 1, completedAt: undefined })]]);
const finished = new Map([[1, makeTypedStage({ id: 1 })]]);
/** @type {import('../src/types.ts').Finding} */
const memoryCaveat = {
  type: 'memoryUtilization', variant: 'memoryBand', dataUnavailable: true, impactBand: 'info',
  recommendation: 'Turn on executor metrics.',
};

/** @type {import('../src/types.ts').Finding} */
const measuredMemoryBand = {
  type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned', impactBand: 'warning',
  executorId: '1', heap: 1, allocatedBytes: 1, executorCount: 1, executorSeconds: 1,
};
/** @type {import('../src/types.ts').Finding} */
const incompleteRun = { type: 'incompleteRun', valueText: 'missing', impactBand: 'warning' };
/**
 * @param {boolean} succeeded
 * @returns {import('../src/types.ts').Job}
 */
const makeJob = (succeeded) => ({
  id: 0, result: succeeded ? 'JobSucceeded' : 'JobFailed', succeeded, stageIds: [1],
  submissionTime: 0, sqlExecutionId: null, exception: null, completionTime: 1000,
});

describe('check coverage', () => {
  it('identifies evidence caveats from the finding variant', () => {
    expect(isCaveat(memoryCaveat)).toBe(true);
    expect(isCaveat(measuredMemoryBand)).toBe(false);
  });

  it('reads the per-stage set from the detector catalog', () => {
    expect([...PER_STAGE_CHECK_TYPES].sort()).toEqual([
      'failures', 'gc', 'partitionSizing', 'retryWaste', 'shuffle', 'skew', 'slowHost', 'speculationWaste',
      'spill', 'stageFailed', 'stageShape', 'stageSlowness', 'straggler', 'tinyTask',
    ]);
  });

  it('marks every per-stage check not run when no stage finished', () => {
    expect(hasFinishedStage(unfinished)).toBe(false);
    const coverage = checkCoverage(unfinished, []);
    expect(coverage.notRunReason('skew')).toBe(NO_FINISHED_STAGE_GAP);
    expect(coverage.isNotRun('utilization')).toBe(false);
  });

  it('marks the run-span checks not run on a log with no end-of-run record', () => {
    const coverage = checkCoverage(finished, [incompleteRun]);
    for (const type of ['utilization', 'memoryUtilization', 'autoscalingChurn']) {
      expect(coverage.notRunReason(type)).toBe(INCOMPLETE_RUN_GAP);
    }
    expect(coverage.isNotRun('skew')).toBe(false);
  });

  it('gives an evidence caveat its own recommendation as the reason', () => {
    const coverage = checkCoverage(finished, [memoryCaveat]);
    expect(coverage.notRunReason('memoryUtilization')).toBe('Turn on executor metrics.');
    expect(verdictGaps([memoryCaveat], false)).toEqual(['Turn on executor metrics.']);
  });

  it('calls a run clean only with no finding, no failed job and nothing missing', () => {
    const jobs = new Map([[0, makeJob(true)]]);
    expect(isCleanRun({ jobs, stages: finished }, [])).toBe(true);
    expect(isCleanRun({ jobs, stages: finished }, [memoryCaveat])).toBe(false);
    expect(isCleanRun({ jobs, stages: unfinished }, [])).toBe(false);
    const failedJobs = new Map([[0, makeJob(false)]]);
    expect(isCleanRun({ jobs: failedJobs, stages: finished }, [])).toBe(false);
  });
});
