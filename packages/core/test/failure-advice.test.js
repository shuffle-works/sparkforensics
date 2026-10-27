import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { adviseFailure, adviseFailureGroups } from '../src/failure-advice.ts';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

const OVERHEAD = [{ kind: 'conf', key: 'spark.executor.memoryOverhead', direction: 'increase', suggested: null }];
const MAX_ATTEMPTS = [{ kind: 'conf', key: 'spark.stage.maxConsecutiveAttempts', direction: 'increase', suggested: null }];

const group = (overrides) => ({
  reason: 'ExecutorLostFailure', className: null, message: null, lossReason: null, stackExcerpt: null, count: 1, ...overrides,
});

const findingOf = (rule, stage) => analyze(makeApp(), new Map([[stage.id, stage]]), [], [], new Map(), new Map())
  .find((f) => f.type === rule);

describe('adviseFailure', () => {
  it.each([
    'Container killed by YARN for exceeding memory limits. 10.4 GB of 10 GB physical memory used.',
    'Container killed by YARN for exceeding physical memory limits.',
    'The executor with id 3 exited with exit code 137(SIGKILL, possible container OOM).',
    'Pod state: OOMKilled',
  ])('reads a container memory kill from %j', (text) => {
    const advice = adviseFailure([text]);
    expect(advice.id).toBe('containerMemoryLimit');
    expect(advice.remediation).toEqual(OVERHEAD);
  });

  it('reads a stage that failed its maximum consecutive attempts', () => {
    const advice = adviseFailure(['Stage 7 has failed the maximum allowable number of times: 4. Most recent failure reason: node lost']);
    expect(advice.id).toBe('stageMaxAttempts');
    expect(advice.remediation).toEqual(MAX_ATTEMPTS);
  });

  it('puts the memory kill first when an aborted stage names it as the last failure', () => {
    const text = 'Stage 7 has failed the maximum allowable number of times: 4. Most recent failure reason: Container killed by YARN for exceeding memory limits.';
    expect(adviseFailure([text]).id).toBe('containerMemoryLimit');
  });

  it('returns null for unknown text, null texts and no texts', () => {
    expect(adviseFailure(['java.lang.IllegalStateException: bad row'])).toBeNull();
    expect(adviseFailure([null, undefined])).toBeNull();
    expect(adviseFailure([])).toBeNull();
  });
});

describe('adviseFailureGroups', () => {
  it('takes the first group with a known message and reads its loss reason, message and class name', () => {
    const groups = [
      group({ reason: 'ExceptionFailure', className: 'java.lang.IllegalStateException' }),
      group({ lossReason: 'Container killed by YARN for exceeding memory limits.' }),
    ];
    expect(adviseFailureGroups(groups).id).toBe('containerMemoryLimit');
    expect(adviseFailureGroups([group({ message: 'OOMKilled' })]).id).toBe('containerMemoryLimit');
    expect(adviseFailureGroups([])).toBeNull();
  });
});

describe('failure findings carry the advice', () => {
  const killed = group({ lossReason: 'Container killed by YARN for exceeding memory limits.', count: 20 });

  it('stageFailed names the stage-attempt fix and keeps the raw reason', () => {
    const reason = 'Stage 1 has failed the maximum allowable number of times: 4. Most recent failure reason: fetch failed';
    const finding = findingOf('stageFailed', makeStage({ stageFailureReason: reason }));
    expect(finding.remediation).toEqual(MAX_ATTEMPTS);
    expect(finding.recommendation).toMatch(/spark\.stage\.maxConsecutiveAttempts/);
    expect(finding.valueText).toBe(reason);
  });

  it('stageFailed keeps the generic advice and no remediation for an unknown reason', () => {
    const finding = findingOf('stageFailed', makeStage({ stageFailureReason: 'Job aborted: unknown' }));
    expect(finding.recommendation).toMatch(/Inspect the driver log/);
    expect(finding.remediation ?? []).toEqual([]);
  });

  it('failures names the memory overhead fix and keeps the failure groups', () => {
    const finding = findingOf('failures', makeStage({
      failedTasks: 20, failureReasons: [{ reason: 'ExecutorLostFailure', count: 20 }], failureGroups: [killed],
    }));
    expect(finding.remediation).toEqual(OVERHEAD);
    expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
    expect(finding.failureGroups).toEqual([killed]);
  });

  it('failures keeps the generic advice for an unknown error', () => {
    const finding = findingOf('failures', makeStage({
      failedTasks: 20, failureReasons: [{ reason: 'ExceptionFailure', count: 20 }],
      failureGroups: [group({ reason: 'ExceptionFailure', className: 'java.lang.IllegalStateException', count: 20 })],
    }));
    expect(finding.recommendation).toMatch(/investigate driver logs/);
    expect(finding.remediation ?? []).toEqual([]);
  });

  it('retryWaste names the memory overhead fix when the retried attempts were memory kills', () => {
    const finding = findingOf('retryWaste', makeStage({
      wastedAttempts: 5, retryWasteMs: 60000, failedTasks: 5, failureGroups: [{ ...killed, count: 5 }],
    }));
    expect(finding.remediation).toEqual(OVERHEAD);
    expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
  });
});
