import { describe, it, expect } from 'vitest';
import { analyzedRunFrom } from './fixtures/analyzed-run.js';
import { adviseFailure, adviseFailureGroup, adviseStageFailure } from '../src/failure-advice.ts';
import { coreFindingGenericRecommendation } from '../src/finding-generic-recommendation.ts';
import { createState, processEvent } from '../src/parser-worker.js';
import { makeTypedStage, makeApp } from './fixtures/stage-app-fixtures.js';

const OVERHEAD = [{ kind: 'conf', key: 'spark.executor.memoryOverhead', direction: 'increase', suggested: null }];
const MAX_ATTEMPTS = [{ kind: 'conf', key: 'spark.stage.maxConsecutiveAttempts', direction: 'increase', suggested: null }];

/** @typedef {import('../src/types.ts').Finding} Finding */

/** @param {Partial<import('../src/task-failure.ts').TaskFailureGroup>} [overrides] @returns {import('../src/task-failure.ts').TaskFailureGroup} */
const group = (overrides) => ({
  reason: 'ExecutorLostFailure', className: null, message: null, lossReason: null, stackExcerpt: null, count: 1, ...overrides,
});

/**
 * @template {Finding['type']} T
 * @param {Finding[]} catalog
 * @param {T} type
 */
function firstOfType(catalog, type) {
  return catalog.find(/** @returns {f is Extract<Finding, { type: T }>} */ (f) => f.type === type);
}

/**
 * The finding of `rule` the stage produces; a missing one fails here rather than on a property read.
 * @template {Finding['type']} T
 * @param {T} rule
 * @param {import('../src/types.ts').Stage} stage
 */
function findingOf(rule, stage) {
  const finding = firstOfType(analyzedRunFrom({ app: makeApp(), stages: new Map([[stage.id, stage]]) }).catalog, rule);
  if (!finding) throw new Error(`expected a ${rule} finding`);
  return finding;
}

/**
 * @template T
 * @param {T | null | undefined} value
 * @returns {T}
 */
function present(value) {
  if (value == null) throw new Error('expected a value');
  return value;
}

const CONTAINER_KILL = 'Container killed by YARN for exceeding memory limits. 10.4 GB of 10 GB physical memory used.';
const MAX_ATTEMPTS_REASON = 'Stage 1 has failed the maximum allowable number of times: 4. Most recent failure reason: fetch failed';

describe('adviseFailure', () => {
  it.each([
    'Container killed by YARN for exceeding memory limits. 10.4 GB of 10 GB physical memory used.',
    'Container killed by YARN for exceeding physical memory limits.',
    'The executor with id 3 exited with exit code 137(SIGKILL, possible container OOM).',
    'Pod state: OOMKilled',
  ])('reads a container memory kill from %j', (text) => {
    const advice = present(adviseFailure([text]));
    expect(advice.id).toBe('containerMemoryLimit');
    expect(advice.remediation).toEqual(OVERHEAD);
    expect(advice.confirmation).toBe('text-only');
  });

  it('reads a stage that failed its maximum consecutive attempts', () => {
    const advice = present(adviseFailure(['Stage 7 has failed the maximum allowable number of times: 4. Most recent failure reason: node lost']));
    expect(advice.id).toBe('stageMaxAttempts');
    expect(advice.remediation).toEqual(MAX_ATTEMPTS);
    expect(advice.confirmation).toBe('text-only');
  });

  it('puts the memory kill first when an aborted stage names it as the last failure', () => {
    const text = 'Stage 7 has failed the maximum allowable number of times: 4. Most recent failure reason: Container killed by YARN for exceeding memory limits.';
    expect(present(adviseFailure([text])).id).toBe('containerMemoryLimit');
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
    expect(present(adviseStageFailure(3, 'fetch failed', [abort])).id).toBe('stageMaxAttempts');
    expect(adviseStageFailure(4, 'fetch failed', [abort])).toBeNull();
    expect(adviseStageFailure(4, abort, [])).toBeNull();
  });

  it('reads a task-failure abort only for the stage it names', () => {
    const taskAbort = `Job aborted due to stage failure: Task 2 in stage 3.0 failed 4 times, most recent failure: Lost task 2.3 in stage 3.0 (TID 40) (host-a executor 5): ExecutorLostFailure (executor 5 exited caused by one of the running tasks) Reason: ${CONTAINER_KILL}`;
    expect(present(adviseStageFailure(3, taskAbort, [taskAbort])).id).toBe('containerMemoryLimit');
    expect(present(adviseStageFailure(3, 'fetch failed', [taskAbort])).id).toBe('containerMemoryLimit');
    expect(adviseStageFailure(4, taskAbort, [taskAbort])).toBeNull();
  });

  it('ignores an abort text that names no stage', () => {
    expect(adviseStageFailure(4, 'fetch failed', [`Job aborted: ${CONTAINER_KILL}`])).toBeNull();
  });
});

describe('adviseFailureGroup', () => {
  it("reads a group's loss reason, message and class name", () => {
    expect(present(adviseFailureGroup(group({ lossReason: CONTAINER_KILL }))).id).toBe('containerMemoryLimit');
    expect(present(adviseFailureGroup(group({ message: 'OOMKilled' }))).id).toBe('containerMemoryLimit');
    expect(adviseFailureGroup(group({ reason: 'ExceptionFailure', className: 'java.lang.IllegalStateException' }))).toBeNull();
    expect(adviseFailureGroup(undefined)).toBeNull();
  });
});

describe('failure findings carry the advice', () => {
  const killed = group({ lossReason: 'Container killed by YARN for exceeding memory limits.', count: 20 });

  it('stageFailed names the stage-attempt fix and keeps the raw reason', () => {
    const finding = findingOf('stageFailed', makeTypedStage({ stageFailureReason: MAX_ATTEMPTS_REASON }));
    expect(finding.remediation).toEqual(MAX_ATTEMPTS);
    expect(finding.recommendation).toMatch(/spark\.stage\.maxConsecutiveAttempts/);
    expect(finding.valueText).toBe(MAX_ATTEMPTS_REASON);
  });

  it('stageFailed keeps the generic advice and no remediation for an unknown reason', () => {
    const finding = findingOf('stageFailed', makeTypedStage({ stageFailureReason: 'Job aborted: unknown' }));
    expect(finding.recommendation).toMatch(/Inspect the driver log/);
    expect(finding.remediation ?? []).toEqual([]);
    expect(coreFindingGenericRecommendation(finding)).toMatch(/Inspect the driver log/);
  });

  it('failures names the memory overhead fix and keeps the failure groups', () => {
    const finding = findingOf('failures', makeTypedStage({
      failedTasks: 20, failureReasons: [{ reason: 'ExecutorLostFailure', count: 20 }], failureGroups: [killed],
    }));
    expect(finding.remediation).toEqual(OVERHEAD);
    expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
    expect(finding.failureGroups).toEqual([killed]);
  });

  it('failures keeps the generic advice for an unknown error', () => {
    const finding = findingOf('failures', makeTypedStage({
      failedTasks: 20, failureReasons: [{ reason: 'ExceptionFailure', count: 20 }],
      failureGroups: [group({ reason: 'ExceptionFailure', className: 'java.lang.IllegalStateException', count: 20 })],
    }));
    expect(finding.recommendation).toMatch(/investigate driver logs/);
    expect(finding.remediation ?? []).toEqual([]);
  });

  it('failures advises only from the dominant error, never from a minority group', () => {
    const finding = findingOf('failures', makeTypedStage({
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
    const finding = findingOf('retryWaste', makeTypedStage({
      wastedAttempts: 5, retryWasteMs: 60000, retryFailureGroups: [{ ...killed, count: 5 }],
    }));
    expect(finding.remediation).toEqual(OVERHEAD);
    expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
  });
});

// Hand-built SparkListener events through the parser, which fills lossReason and stageFailureReason.
describe('failure advice from parsed events', () => {
  /** @param {ReturnType<typeof processEvent>} message */
  function stageOf(message) {
    if (message?.type !== 'stage') throw new Error('expected a stage message');
    return message.data;
  }

  /** @param {{ lostTasks?: number, failureReason?: string, retrySucceeds?: boolean, lossReason?: string }} options */
  function parseStage({ lostTasks = 0, failureReason, retrySucceeds = false, lossReason = CONTAINER_KILL }) {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    let taskId = 0;
    // The Spark fields the schema does not name (executor id, exit cause) ride along unvalidated.
    const lostReason = { Reason: 'ExecutorLostFailure', 'Executor ID': '3', 'Exit Caused By App': true, 'Loss Reason': lossReason };
    /** @param {number} index @param {boolean} failed */
    const taskEnd = (index, failed) => processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': taskId++, Index: index, 'Launch Time': 0, 'Finish Time': 10000, Failed: failed },
      'Task End Reason': failed
        ? lostReason
        : { Reason: 'Success' },
      'Task Metrics': {},
    }, s);
    // Each lost task fails, then its retry fails too (the task stays failed) or succeeds.
    for (let i = 0; i < lostTasks; i++) taskEnd(i, true);
    if (lostTasks) processEvent({ Event: 'SparkListenerExecutorRemoved', Timestamp: 10000, 'Executor ID': '3', 'Removed Reason': lossReason }, s);
    for (let i = 0; i < lostTasks; i++) taskEnd(i, !retrySucceeds);
    for (let i = lostTasks; i < 20; i++) taskEnd(i, false);
    const info = { 'Stage ID': 1, 'Completion Time': 20000, ...(failureReason && { 'Failure Reason': failureReason }) };
    const stage = stageOf(processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': info }, s));
    return analyzedRunFrom({ app: makeApp(), stages: new Map([[1, stage]]) }).catalog;
  }

  it('reads a container memory kill from the TaskEnd loss reason into failures and retryWaste', () => {
    const findings = parseStage({ lostTasks: 5 });
    for (const type of /** @type {('failures' | 'retryWaste')[]} */ (['failures', 'retryWaste'])) {
      const finding = present(firstOfType(findings, type));
      expect(finding.remediation).toEqual(OVERHEAD);
      expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
      expect(coreFindingGenericRecommendation(finding)).toMatch(/spark\.executor\.memoryOverhead/);
    }
    expect(present(firstOfType(findings, 'failures')).failureGroups[0].lossReason).toBe(CONTAINER_KILL);
  });

  it.each([
    CONTAINER_KILL,
    'The executor with id 3 exited with exit code 137(SIGKILL, possible container OOM). Pod state: OOMKilled',
  ])('names the memory overhead fix on retryWaste when the retries succeed (%j)', (lossReason) => {
    const findings = parseStage({ lostTasks: 5, retrySucceeds: true, lossReason });
    expect(findings.find((f) => f.type === 'failures')).toBeUndefined();
    const finding = present(firstOfType(findings, 'retryWaste'));
    expect(finding.remediation).toEqual(OVERHEAD);
    expect(finding.recommendation).toMatch(/spark\.executor\.memoryOverhead/);
    expect(coreFindingGenericRecommendation(finding)).toMatch(/spark\.executor\.memoryOverhead/);
  });

  // Spark's FetchFailed path: the failing stage closes with its last attempt's fetch failure, then
  // the abort names it in the job's exception and in the reason of any stage it cancels.
  /** @param {{ withSibling?: boolean, failingReason?: string, abort?: string }} options */
  function abortedJob({ withSibling = false, failingReason = FETCH_FAILED, abort = JOB_ABORTED }) {
    const s = createState();
    const stageIds = withSibling ? [1, 2] : [1];
    processEvent({ Event: 'SparkListenerJobStart', 'Job ID': 0, 'Submission Time': 0, 'Stage IDs': stageIds }, s);
    for (const id of stageIds) processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': id, 'Submission Time': 0 } }, s);
    /** @param {number} id @param {string} reason */
    const closeStage = (id, reason) => {
      const info = { 'Stage ID': id, 'Completion Time': 20000, 'Failure Reason': reason };
      return stageOf(processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': info }, s));
    };
    const stages = new Map([[1, closeStage(1, failingReason)]]);
    if (withSibling) stages.set(2, closeStage(2, abort));
    processEvent({
      Event: 'SparkListenerJobEnd', 'Job ID': 0, 'Completion Time': 20000,
      'Job Result': { Result: 'JobFailed', Exception: { Message: abort } },
    }, s);
    return analyzedRunFrom({ app: makeApp(), stages, jobs: s.jobs }).catalog;
  }
  const FETCH_FAILED = 'org.apache.spark.shuffle.FetchFailedException: Failed to connect to host-a/10.0.0.1:7337';
  const JOB_ABORTED = `Job aborted due to stage failure: ResultStage 1 (count at Example.scala:10) has failed the maximum allowable number of times: 4. Most recent failure reason:\n${FETCH_FAILED}`;
  /** @param {Finding[]} findings @param {number} id */
  function stageFailedOf(findings, id) {
    const finding = findings.find(/** @returns {f is import('../src/finding-types.ts').StageFailedFinding} */ (f) => f.type === 'stageFailed' && f.stageId === id);
    if (!finding) throw new Error(`expected a stageFailed finding for stage ${id}`);
    return finding;
  }

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
