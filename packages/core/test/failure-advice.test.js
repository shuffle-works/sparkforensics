import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { adviseFailure, adviseFailureGroup } from '../src/failure-advice.ts';
import { coreFindingGenericRecommendation } from '../src/finding-generic-recommendation.ts';
import { createState, processEvent } from '../src/parser-worker.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

const OVERHEAD = [{ kind: 'conf', key: 'spark.executor.memoryOverhead', direction: 'increase', suggested: null }];
const MAX_ATTEMPTS = [{ kind: 'conf', key: 'spark.stage.maxConsecutiveAttempts', direction: 'increase', suggested: null }];

const group = (overrides) => ({
  reason: 'ExecutorLostFailure', className: null, message: null, lossReason: null, stackExcerpt: null, count: 1, ...overrides,
});

const findingOf = (rule, stage) => analyze(makeApp(), new Map([[stage.id, stage]]), [], [], new Map(), new Map())
  .find((f) => f.type === rule);

const CONTAINER_KILL = 'Container killed by YARN for exceeding memory limits. 10.4 GB of 10 GB physical memory used.';
const MAX_ATTEMPTS_REASON = 'Stage 1 has failed the maximum allowable number of times: 4. Most recent failure reason: fetch failed';

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
    expect(advice.confirmation).toBe('text-only');
  });

  it('reads a stage that failed its maximum consecutive attempts', () => {
    const advice = adviseFailure(['Stage 7 has failed the maximum allowable number of times: 4. Most recent failure reason: node lost']);
    expect(advice.id).toBe('stageMaxAttempts');
    expect(advice.remediation).toEqual(MAX_ATTEMPTS);
    expect(advice.confirmation).toBe('text-only');
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

describe('adviseFailureGroup', () => {
  it("reads a group's loss reason, message and class name", () => {
    expect(adviseFailureGroup(group({ lossReason: CONTAINER_KILL })).id).toBe('containerMemoryLimit');
    expect(adviseFailureGroup(group({ message: 'OOMKilled' })).id).toBe('containerMemoryLimit');
    expect(adviseFailureGroup(group({ reason: 'ExceptionFailure', className: 'java.lang.IllegalStateException' }))).toBeNull();
    expect(adviseFailureGroup(undefined)).toBeNull();
  });
});

describe('failure findings carry the advice', () => {
  const killed = group({ lossReason: 'Container killed by YARN for exceeding memory limits.', count: 20 });

  it('stageFailed names the stage-attempt fix and keeps the raw reason', () => {
    const finding = findingOf('stageFailed', makeStage({ stageFailureReason: MAX_ATTEMPTS_REASON }));
    expect(finding.remediation).toEqual(MAX_ATTEMPTS);
    expect(finding.recommendation).toMatch(/spark\.stage\.maxConsecutiveAttempts/);
    expect(finding.valueText).toBe(MAX_ATTEMPTS_REASON);
  });

  it('stageFailed keeps the generic advice and no remediation for an unknown reason', () => {
    const finding = findingOf('stageFailed', makeStage({ stageFailureReason: 'Job aborted: unknown' }));
    expect(finding.recommendation).toMatch(/Inspect the driver log/);
    expect(finding.remediation ?? []).toEqual([]);
    expect(coreFindingGenericRecommendation(finding)).toMatch(/Inspect the driver log/);
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

  it('failures advises only from the dominant error, never from a minority group', () => {
    const finding = findingOf('failures', makeStage({
      failedTasks: 100,
      failureReasons: [{ reason: 'ExceptionFailure', count: 95 }, { reason: 'ExecutorLostFailure', count: 5 }],
      failureGroups: [
        group({ reason: 'ExceptionFailure', className: 'java.lang.IllegalStateException', count: 95 }),
        { ...killed, count: 5 },
      ],
    }));
    expect(finding.recommendation).toMatch(/dominant error: java\.lang\.IllegalStateException/);
    expect(finding.recommendation).not.toMatch(/memoryOverhead/);
    expect(finding.remediation ?? []).toEqual([]);
  });

  it('retryWaste names the memory overhead fix when the retried attempts were memory kills', () => {
    const finding = findingOf('retryWaste', makeStage({
      wastedAttempts: 5, retryWasteMs: 60000, failedTasks: 5,
      failureReasons: [{ reason: 'ExecutorLostFailure', count: 5 }], failureGroups: [{ ...killed, count: 5 }],
    }));
    expect(finding.remediation).toEqual(OVERHEAD);
    expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
  });
});

// Hand-built SparkListener events through the parser, which fills lossReason and stageFailureReason.
describe('failure advice from parsed events', () => {
  function parseStage({ lostTasks = 0, failureReason }) {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    let taskId = 0;
    const taskEnd = (index, failed) => processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': taskId++, Index: index, 'Launch Time': 0, 'Finish Time': 10000, Failed: failed },
      'Task End Reason': failed
        ? { Reason: 'ExecutorLostFailure', 'Executor ID': '3', 'Exit Caused By App': true, 'Loss Reason': CONTAINER_KILL }
        : { Reason: 'Success' },
      'Task Metrics': {},
    }, s);
    // Each lost task fails twice: the retry is wasted and the task stays failed.
    for (let i = 0; i < lostTasks; i++) taskEnd(i, true);
    if (lostTasks) processEvent({ Event: 'SparkListenerExecutorRemoved', Timestamp: 10000, 'Executor ID': '3', 'Removed Reason': CONTAINER_KILL }, s);
    for (let i = 0; i < lostTasks; i++) taskEnd(i, true);
    for (let i = lostTasks; i < 20; i++) taskEnd(i, false);
    const info = { 'Stage ID': 1, 'Completion Time': 20000, ...(failureReason && { 'Failure Reason': failureReason }) };
    const stage = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': info }, s).data;
    return analyze(makeApp(), new Map([[1, stage]]), [], [], new Map(), new Map());
  }

  it('reads a container memory kill from the TaskEnd loss reason into failures and retryWaste', () => {
    const findings = parseStage({ lostTasks: 5 });
    for (const type of ['failures', 'retryWaste']) {
      const finding = findings.find((f) => f.type === type);
      expect(finding.remediation).toEqual(OVERHEAD);
      expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
      expect(coreFindingGenericRecommendation(finding)).toMatch(/spark\.executor\.memoryOverhead/);
    }
    expect(findings.find((f) => f.type === 'failures').failureGroups[0].lossReason).toBe(CONTAINER_KILL);
  });

  it('reads a stage that failed its maximum attempts from the StageCompleted failure reason', () => {
    const finding = parseStage({ failureReason: MAX_ATTEMPTS_REASON }).find((f) => f.type === 'stageFailed');
    expect(finding.remediation).toEqual(MAX_ATTEMPTS);
    expect(finding.valueText).toBe(MAX_ATTEMPTS_REASON);
    expect(coreFindingGenericRecommendation(finding)).toMatch(/spark\.stage\.maxConsecutiveAttempts/);
  });
});
