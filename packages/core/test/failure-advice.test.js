import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { adviseFailure, adviseFailureGroup, adviseStageFailure } from '../src/failure-advice.ts';
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

describe('adviseStageFailure', () => {
  const abort = 'Job aborted due to stage failure: ShuffleMapStage 3 (map at Example.scala:5) has failed the maximum allowable number of times: 4. Most recent failure reason: fetch failed';

  it('reads an abort text only for the stage it names', () => {
    expect(adviseStageFailure(3, 'fetch failed', [abort]).id).toBe('stageMaxAttempts');
    expect(adviseStageFailure(4, 'fetch failed', [abort])).toBeNull();
    expect(adviseStageFailure(4, abort, [])).toBeNull();
  });

  it('reads a task-failure abort only for the stage it names', () => {
    const taskAbort = `Job aborted due to stage failure: Task 2 in stage 3.0 failed 4 times, most recent failure: Lost task 2.3 in stage 3.0 (TID 40) (host-a executor 5): ExecutorLostFailure (executor 5 exited caused by one of the running tasks) Reason: ${CONTAINER_KILL}`;
    expect(adviseStageFailure(3, taskAbort, [taskAbort]).id).toBe('containerMemoryLimit');
    expect(adviseStageFailure(3, 'fetch failed', [taskAbort]).id).toBe('containerMemoryLimit');
    expect(adviseStageFailure(4, taskAbort, [taskAbort])).toBeNull();
  });

  it('ignores an abort text that names no stage', () => {
    expect(adviseStageFailure(4, 'fetch failed', [`Job aborted: ${CONTAINER_KILL}`])).toBeNull();
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
      wastedAttempts: 5, retryWasteMs: 60000, retryFailureGroups: [{ ...killed, count: 5 }],
    }));
    expect(finding.remediation).toEqual(OVERHEAD);
    expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
  });
});

// Hand-built SparkListener events through the parser, which fills lossReason and stageFailureReason.
describe('failure advice from parsed events', () => {
  function parseStage({ lostTasks = 0, failureReason, retrySucceeds = false, lossReason = CONTAINER_KILL }) {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    let taskId = 0;
    const taskEnd = (index, failed) => processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': taskId++, Index: index, 'Launch Time': 0, 'Finish Time': 10000, Failed: failed },
      'Task End Reason': failed
        ? { Reason: 'ExecutorLostFailure', 'Executor ID': '3', 'Exit Caused By App': true, 'Loss Reason': lossReason }
        : { Reason: 'Success' },
      'Task Metrics': {},
    }, s);
    // Each lost task fails, then its retry fails too (the task stays failed) or succeeds.
    for (let i = 0; i < lostTasks; i++) taskEnd(i, true);
    if (lostTasks) processEvent({ Event: 'SparkListenerExecutorRemoved', Timestamp: 10000, 'Executor ID': '3', 'Removed Reason': lossReason }, s);
    for (let i = 0; i < lostTasks; i++) taskEnd(i, !retrySucceeds);
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

  it.each([
    CONTAINER_KILL,
    'The executor with id 3 exited with exit code 137(SIGKILL, possible container OOM). Pod state: OOMKilled',
  ])('names the memory overhead fix on retryWaste when the retries succeed (%j)', (lossReason) => {
    const findings = parseStage({ lostTasks: 5, retrySucceeds: true, lossReason });
    expect(findings.find((f) => f.type === 'failures')).toBeUndefined();
    const finding = findings.find((f) => f.type === 'retryWaste');
    expect(finding.remediation).toEqual(OVERHEAD);
    expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
    expect(coreFindingGenericRecommendation(finding)).toMatch(/spark\.executor\.memoryOverhead/);
  });

  // Spark's FetchFailed path: the failing stage closes with its last attempt's fetch failure, then
  // the abort names it in the job's exception and in the reason of any stage it cancels.
  function abortedJob({ withSibling, failingReason = FETCH_FAILED, abort = JOB_ABORTED }) {
    const s = createState();
    const stageIds = withSibling ? [1, 2] : [1];
    processEvent({ Event: 'SparkListenerJobStart', 'Job ID': 0, 'Submission Time': 0, 'Stage IDs': stageIds }, s);
    for (const id of stageIds) processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': id, 'Submission Time': 0 } }, s);
    const closeStage = (id, reason) => {
      const info = { 'Stage ID': id, 'Completion Time': 20000, 'Failure Reason': reason };
      return processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': info }, s).data;
    };
    const stages = new Map([[1, closeStage(1, failingReason)]]);
    if (withSibling) stages.set(2, closeStage(2, abort));
    processEvent({
      Event: 'SparkListenerJobEnd', 'Job ID': 0, 'Completion Time': 20000,
      'Job Result': { Result: 'JobFailed', Exception: { Message: abort } },
    }, s);
    return analyze(makeApp(), stages, [], [], s.jobs, new Map());
  }
  const FETCH_FAILED = 'org.apache.spark.shuffle.FetchFailedException: Failed to connect to host-a/10.0.0.1:7337';
  const JOB_ABORTED = `Job aborted due to stage failure: ResultStage 1 (count at Example.scala:10) has failed the maximum allowable number of times: 4. Most recent failure reason:\n${FETCH_FAILED}`;
  const stageFailedOf = (findings, id) => findings.find((f) => f.type === 'stageFailed' && f.stageId === id);

  it.each([false, true])('names the max-attempts fix on the stage the job abort names (running sibling: %s)', (withSibling) => {
    const finding = stageFailedOf(abortedJob({ withSibling }), 1);
    expect(finding.remediation).toEqual(MAX_ATTEMPTS);
    expect(finding.valueText).toBe(FETCH_FAILED);
    expect(coreFindingGenericRecommendation(finding)).toMatch(/spark\.stage\.maxConsecutiveAttempts/);
  });

  it('puts a task-failure abort on the failing stage, not on the running sibling it cancelled', () => {
    const taskAbort = `Job aborted due to stage failure: Task 2 in stage 1.0 failed 4 times, most recent failure: Lost task 2.3 in stage 1.0 (TID 40) (host-a executor 5): ExecutorLostFailure (executor 5 exited caused by one of the running tasks) Reason: ${CONTAINER_KILL}`;
    const findings = abortedJob({ withSibling: true, failingReason: taskAbort, abort: taskAbort });
    expect(stageFailedOf(findings, 1).remediation).toEqual(OVERHEAD);
    const sibling = stageFailedOf(findings, 2);
    expect(sibling.valueText).toBe(taskAbort);
    expect(sibling.remediation ?? []).toEqual([]);
  });

  it('gives the cancelled sibling no max-attempts advice', () => {
    const sibling = stageFailedOf(abortedJob({ withSibling: true }), 2);
    expect(sibling.valueText).toBe(JOB_ABORTED);
    expect(sibling.remediation ?? []).toEqual([]);
    expect(sibling.recommendation).toMatch(/Inspect the driver log/);
  });
});
