import { describe, it, expect } from 'vitest';
import { buildRecommendationRollup, isEligible } from '../src/recommendation-rollup.ts';
import { attributeTail, TAIL_FACTOR } from '../src/stage-quantiles.js';
import { createState, processEvent } from '../src/parser-worker.js';
import { makeTypedStage, makeApp } from './fixtures/stage-app-fixtures.js';
import { analyzedRunFrom } from './fixtures/analyzed-run.js';
import { present, findingOfType } from './fixtures/present.js';

/** @typedef {import('../src/types.ts').Finding} Finding */
/** @typedef {import('../src/types.ts').TailAttribution} TailAttribution */
/** @typedef {Parameters<typeof attributeTail>[0] extends Iterable<infer T> ? T : never} TailTask */

/** @param {ReturnType<typeof processEvent>} message */
function stageOf(message) {
  if (message?.type !== 'stage') throw new Error('expected a stage message');
  return message.data;
}

// The tail of a run the test expects to have one.
/** @param {TailTask[]} tasks @param {number} p50 */
function tailOf(tasks, p50) {
  return present(attributeTail(tasks, p50));
}

// Volumes at a scale above the floors a median is taken against (1 MiB, 1000 records).
const BYTES = 1e6;
const RECS = 1000;
/** @param {Partial<TailTask>} [over] @returns {TailTask} */
const task = (over = {}) => ({
  failed: false, duration: 1000, host: 'h1', gcTime: 0, fetchWaitTime: 0, executorRunTime: 1000, executorCpuTime: 0,
  inputBytes: 100 * BYTES, inputRecords: 10 * RECS, shuffleRead: 0, shuffleReadRecords: 0, ...over,
});
/** @param {number} n @param {Partial<TailTask>} [over] */
const many = (n, over) => Array.from({ length: n }, () => task(over));

describe('attributeTail', () => {
  it('has no tail when no task runs over TAIL_FACTOR x P50', () => {
    expect(TAIL_FACTOR).toBe(3);
    expect(attributeTail(many(20), 1000)).toBeNull();
    expect(attributeTail([...many(19), task({ duration: 3000 })], 1000)).toBeNull();
  });

  it('attributes a tail that reads proportionally more data to data', () => {
    const t = tailOf([...many(19), task({ duration: 10000, inputBytes: 1000 * BYTES, inputRecords: 100 * RECS })], 1000);
    // 10x the median task's bytes and records: run time scaled with it, so all 9000ms of excess is data.
    expect(t).toMatchObject({ tasks: 1, excessMs: 9000, dataMs: 9000, gcMs: 0, fetchWaitMs: 0, hostMs: 0, dataRatio: 10 });
  });

  it('counts shuffle-read bytes and records as data volume', () => {
    const base = { inputBytes: 0, inputRecords: 0, shuffleRead: 100 * BYTES, shuffleReadRecords: 10 * RECS };
    const t = tailOf([...many(19, base), task({ ...base, duration: 5000, shuffleRead: 400 * BYTES, shuffleReadRecords: 40 * RECS })], 1000);
    expect(t.dataRatio).toBe(4);
    expect(t.dataMs).toBe(3000);
  });

  it('takes the further of the bytes and records ratios', () => {
    const t = tailOf([...many(19), task({ duration: 4000, inputBytes: 100 * BYTES, inputRecords: 40 * RECS })], 1000);
    expect(t.dataRatio).toBe(4);
    expect(t.dataMs).toBe(3000);
  });

  it('attributes what data does not explain to GC, then fetch wait, without counting a millisecond twice', () => {
    const slow = task({ duration: 10000, gcTime: 5000, fetchWaitTime: 9000 });
    const t = tailOf([...many(19), slow], 1000);
    expect(t.dataMs).toBe(0);
    expect(t.gcMs).toBe(5000);
    expect(t.fetchWaitMs).toBe(4000); // 9000 of fetch wait, but only 4000ms of excess is left after GC
    expect(t.gcMs + t.fetchWaitMs + t.dataMs + t.hostMs).toBeLessThanOrEqual(t.excessMs);
  });

  it("measures GC and fetch wait over the median task's own", () => {
    const base = { gcTime: 800, fetchWaitTime: 100 };
    const t = tailOf([...many(19, base), task({ ...base, duration: 5000, gcTime: 2800 })], 1000);
    expect(t.gcMs).toBe(2000);
    expect(t.fetchWaitMs).toBe(0);
  });

  it('attributes the remainder to a host that holds most of the tail out of proportion to its tasks', () => {
    const tail = Array.from({ length: 4 }, () => task({ duration: 6000, host: 'slow' }));
    const t = tailOf([...many(36, { host: 'a' }), ...many(36, { host: 'b' }), ...many(28, { host: 'slow' }).slice(4), ...tail], 1000);
    expect(t.host).toBe('slow');
    expect(t.hostTasks).toBe(4);
    expect(t.hostMs).toBe(20000);
  });

  it('does not blame a host for a tail it holds only its fair share of, or fewer than 3 tasks of', () => {
    const evenTail = [task({ duration: 6000, host: 'a' }), task({ duration: 6000, host: 'a' }), task({ duration: 6000, host: 'a' })];
    // 'a' holds all 3 tail tasks but also 60 of 100 tasks: under twice its share.
    const even = tailOf([...many(57, { host: 'a' }), ...many(40, { host: 'b' }), ...evenTail], 1000);
    expect(even.host).toBeNull();
    expect(even.hostMs).toBe(0);
    const single = tailOf([...many(20, { host: 'a' }), ...many(20, { host: 'b' }), task({ duration: 9000, host: 'c' })], 1000);
    expect(single.host).toBeNull();
  });

  it('has no data ratio when the median task read nothing', () => {
    const none = { inputBytes: 0, inputRecords: 0, shuffleRead: 0, shuffleReadRecords: 0 };
    const t = tailOf([...many(19, none), task({ ...none, duration: 9000 })], 1000);
    expect(t.dataRatio).toBeNull();
    expect(t.dataMs).toBe(0);
  });

  it('gives GC and fetch wait their excess first when the median task read nothing, and data what they leave', () => {
    const none = { inputBytes: 0, inputRecords: 0, shuffleRead: 0, shuffleReadRecords: 0 };
    const slow = task({ ...none, duration: 30000, gcTime: 18000, fetchWaitTime: 2000, shuffleRead: 5e8, shuffleReadRecords: 1e6 });
    const t = tailOf([...many(99, none), slow], 1000);
    expect(t).toMatchObject({ tasks: 1, excessMs: 29000, dataMs: 9000, gcMs: 18000, fetchWaitMs: 2000, dataRatio: null });
  });

  it('does not call a tail that is almost all GC data because it read a few bytes when the median read nothing', () => {
    const none = { inputBytes: 0, inputRecords: 0, shuffleRead: 0, shuffleReadRecords: 0 };
    const slow = task({ ...none, duration: 5900, gcTime: 4800, inputBytes: 10, inputRecords: 1 });
    const t = tailOf([...many(99, none), slow], 1000);
    expect(t).toMatchObject({ excessMs: 4900, dataMs: 0, gcMs: 4800 });
  });

  it('reads a median task under the volume floors as having read almost nothing: no ratio, however large the tail read', () => {
    // A median task that read 4 bytes against a tail task that read 28 GB would print about 28,000x.
    const tiny = { inputBytes: 4, inputRecords: 1, shuffleRead: 0, shuffleReadRecords: 0 };
    const slow = task({ ...tiny, duration: 9000, gcTime: 2000, inputBytes: 28 * 1024 ** 3, inputRecords: 900 });
    const t = tailOf([...many(19, tiny), slow], 1000);
    expect(t.dataRatio).toBeNull();
    // GC claims its time first; the tail task read data, so the rest is data.
    expect(t).toMatchObject({ gcMs: 2000, dataMs: 6000 });
    // At the floors the ratio is real again.
    const floor = { inputBytes: 1024 * 1024, inputRecords: 1, shuffleRead: 0, shuffleReadRecords: 0 };
    const big = tailOf([...many(19, floor), task({ ...floor, duration: 9000, inputBytes: 50 * 1024 * 1024 })], 1000);
    expect(big.dataRatio).toBe(50);
  });

  it('ignores failed attempts, whose metrics stop where they died', () => {
    expect(attributeTail([...many(19), task({ duration: 9000, failed: true })], 1000)).toBeNull();
  });

  it("reports the tail's CPU time over its run time, null when the log has none", () => {
    const withCpu = tailOf([...many(19), task({ duration: 9000, executorRunTime: 9000, executorCpuTime: 4.5e9 })], 1000);
    expect(withCpu.cpuPct).toBe(50);
    expect(tailOf([...many(19), task({ duration: 9000 })], 1000).cpuPct).toBeNull();
  });
});

describe('finalizeStage tail attribution', () => {
  /** @param {{ duration: number, host?: string, gc?: number, cpuMs?: number, shuffleBytes?: number, fetchWait?: number, shuffleRecords?: number, inputBytes?: number, inputRecords?: number }[]} tasks */
  function runStage(tasks) {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    tasks.forEach((t, i) => processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': i, Index: i, 'Launch Time': 0, 'Finish Time': t.duration, Host: t.host ?? 'h1' },
      'Task Metrics': {
        'JVM GC Time': t.gc ?? 0, 'Executor Run Time': t.duration, 'Executor CPU Time': (t.cpuMs ?? 0) * 1e6,
        'Shuffle Read Metrics': { 'Remote Bytes Read': t.shuffleBytes ?? 0, 'Fetch Wait Time': t.fetchWait ?? 0, 'Total Records Read': t.shuffleRecords ?? 0 },
        'Input Metrics': { 'Bytes Read': t.inputBytes ?? 0, 'Records Read': t.inputRecords ?? 0 },
      },
    }, s));
    return stageOf(processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 20000 } }, s));
  }

  it('reads records from the TaskEnd metrics and attributes the tail', () => {
    const tasks = Array.from({ length: 19 }, () => ({ duration: 1000, shuffleBytes: 100 * BYTES, shuffleRecords: 10 * RECS }));
    tasks.push({ duration: 8000, shuffleBytes: 800 * BYTES, shuffleRecords: 80 * RECS });
    const data = runStage(tasks);
    expect(data.tailAttribution).toMatchObject({ tasks: 1, excessMs: 7000, dataMs: 7000, dataRatio: 8 });
  });

  it('leaves the field off a stage with no tail', () => {
    expect(runStage(Array.from({ length: 10 }, () => ({ duration: 1000 }))).tailAttribution).toBeUndefined();
  });
});

describe('skew and straggler by tail cause', () => {
  const app = makeApp({ startTime: 0, endTime: 500000 });
  // A stage whose duration shape trips both detectors: P95/median 9x and 12 of 100 tasks over 4x P50.
  /** @param {TailAttribution | null} tailAttribution */
  const stage = (tailAttribution) => new Map([[1, makeTypedStage({
    taskCount: 100, completedAt: 50000, taskDurationP50: 1000, taskDurationP95: 9000, taskDurationMax: 40000,
    stragglerCount: 12, stragglerExcessMs: 300000, longestNonStragglerMs: 3000, peakConcurrentTasks: 10,
    ...(tailAttribution ? { tailAttribution } : {}),
  })]]);
  /** @param {Partial<TailAttribution>} [over] @returns {TailAttribution} */
  const tail = (over) => ({
    tasks: 12, excessMs: 100000, dataMs: 0, gcMs: 0, fetchWaitMs: 0, hostMs: 0, host: null, hostTasks: 0,
    dataRatio: 1, cpuPct: null, ...over,
  });
  /** @param {Finding[]} findings */
  const types = (findings) => findings.map((f) => f.type).filter((t) => t === 'skew' || t === 'straggler').sort();

  it('reports a data-driven tail as skew only, with the data volume', () => {
    const findings = analyzedRunFrom({ app, stages: stage(tail({ dataMs: 90000, dataRatio: 7.24 })) }).catalog;
    expect(types(findings)).toEqual(['skew']);
    const skew = findingOfType(findings, 'skew');
    expect(skew).toMatchObject({ cause: 'data', dataRatio: 7.2 });
    expect(skew.validationRequired).not.toContain('overlaps');
  });

  it.each([
    ['gc', { gcMs: 60000 }, 'GC accounts for 60%'],
    ['fetchWait', { fetchWaitMs: 70000 }, 'shuffle fetches accounts for 70%'],
    ['host', { hostMs: 80000, host: 'worker-7', hostTasks: 9 }, '9 of the 12 slow tasks ran on worker-7'],
    ['unexplained', {}, 'read no more data than the median task'],
  ])('reports a %s tail as straggler only, with the cause', (cause, over, text) => {
    const findings = analyzedRunFrom({ app, stages: stage(tail(over)) }).catalog;
    expect(types(findings)).toEqual(['straggler']);
    const straggler = findingOfType(findings, 'straggler');
    expect(straggler.cause).toBe(cause);
    expect(straggler.recommendation).toContain(text);
    expect(straggler.recommendation).not.toContain('salt the key');
    expect(straggler.origin).toBeUndefined();
  });

  it('raises executor memory for a GC-driven tail and speculation for a host-driven one', () => {
    const gc = findingOfType(analyzedRunFrom({ app, stages: stage(tail({ gcMs: 60000 })) }).catalog, 'straggler');
    expect(gc.remediation).toEqual([{ kind: 'conf', key: 'spark.executor.memory', direction: 'increase', suggested: null }]);
    const host = findingOfType(analyzedRunFrom({ app, stages: stage(tail({ hostMs: 80000, host: 'w', hostTasks: 9 })) }).catalog, 'straggler');
    expect(host.remediation).toEqual([{ kind: 'conf', key: 'spark.speculation', direction: 'set', suggested: true }]);
  });

  it('gives a stage with a GC-bound tail no low-GC advice, and leaves other stages theirs', () => {
    // Stage 1's GC share of run time is low, which alone would earn the low-GC note; its tail is GC-bound.
    const stages = new Map([[1, { ...present(stage(tail({ gcMs: 60000 })).get(1)), gcPct: 3, executorRunTime: 60000 }]]);
    stages.set(2, makeTypedStage({ id: 2, gcPct: 3, executorRunTime: 60000, completedAt: 50000 }));
    const findings = analyzedRunFrom({ app, stages }).catalog;
    expect(findingOfType(findings.filter((f) => f.stageId === 1), 'straggler').cause).toBe('gc');
    const low = findings.filter((f) => f.type === 'gc' && f.direction === 'low');
    expect(low.map((f) => f.stageId)).toEqual([2]);
  });

  it('says whether the unexplained tail waited or computed', () => {
    const waiting = findingOfType(analyzedRunFrom({ app, stages: stage(tail({ cpuPct: 20 })) }).catalog, 'straggler');
    expect(waiting.recommendation).toContain('mostly waited');
    const busy = findingOfType(analyzedRunFrom({ app, stages: stage(tail({ cpuPct: 95 })) }).catalog, 'straggler');
    expect(busy.recommendation).toContain('the work itself is slow');
  });

  it('reports a tail with no data volume to compare as straggler alone, with no key advice', () => {
    const findings = analyzedRunFrom({ app, stages: stage(tail({ dataRatio: null })) }).catalog;
    expect(types(findings)).toEqual(['straggler']);
    const straggler = findingOfType(findings, 'straggler');
    expect(straggler.cause).toBe('unattributed');
    expect(straggler.remediation).toBeUndefined();
    expect(straggler.recommendation).toMatch(/: nothing in the log attributes the slow tasks to data volume/);
    expect(straggler.recommendation).not.toMatch(/salt the key|repartition on a better key/);
    const rollup = buildRecommendationRollup(findings.filter(isEligible), new Map([[1, { submittedAt: 0, completedAt: 50000 }]]));
    expect(rollup.filter((g) => g.type === 'skew' || g.type === 'straggler')).toHaveLength(1);
  });

  it('leaves a stage with no attribution to straggler when a tuned warn ratio below the tail factor admits it', () => {
    // P95/median 2.5x: under the 3x tail factor, so no task is in the tail and attributeTail has nothing to say.
    const quiet = new Map([[1, makeTypedStage({
      taskCount: 100, completedAt: 50000, taskDurationP50: 1000, taskDurationP95: 2500, taskDurationMax: 3000,
      stragglerCount: 12, stragglerExcessMs: 300000, longestNonStragglerMs: 3000, peakConcurrentTasks: 10,
    })]]);
    expect(types(analyzedRunFrom({ app, stages: quiet }).catalog)).toEqual(['straggler']);
    const tuned = analyzedRunFrom({ app, stages: quiet }, { thresholds: { skew: { ratioWarn: 2 } } }).catalog;
    expect(types(tuned)).toEqual(['straggler']);
    expect(findingOfType(tuned, 'straggler').cause).toBe('unattributed');
  });

  it('describes a tail only skew\'s gate admits by its ratio, never as a 0% share', () => {
    // 1 of 400 tasks over 4x P50: under straggler's own share gate, so only skew's duration gate admits it.
    const few = new Map([[1, makeTypedStage({
      taskCount: 400, completedAt: 50000, taskDurationP50: 1000, taskDurationP95: 9000, taskDurationMax: 40000,
      stragglerCount: 1, stragglerExcessMs: 39000, longestNonStragglerMs: 9000, peakConcurrentTasks: 10,
    })]]);
    for (const tailAttribution of [null, tail({ tasks: 1, dataRatio: null })]) {
      const stages = new Map([[1, { ...present(few.get(1)), ...(tailAttribution ? { tailAttribution } : {}) }]]);
      const straggler = findingOfType(analyzedRunFrom({ app, stages }).catalog, 'straggler');
      expect(straggler).toMatchObject({ metric: 'P95/median', value: 9, unit: 'ratio' });
      expect(straggler.recommendation).toMatch(/^Task duration ratio \(P95\/median\) is 9×: nothing in the log attributes the slow tasks to data volume/);
      expect(straggler.recommendation).not.toMatch(/0% of tasks/);
    }
  });

  it('reports a stage with no tail attribution as straggler alone', () => {
    expect(types(analyzedRunFrom({ app, stages: stage(null) }).catalog)).toEqual(['straggler']);
  });

  it('lets data-share thresholds move the cut', () => {
    const mixed = tail({ dataMs: 40000, gcMs: 50000 });
    expect(types(analyzedRunFrom({ app, stages: stage(mixed) }).catalog)).toEqual(['straggler']);
    const tuned = analyzedRunFrom({ app, stages: stage(mixed) }, { thresholds: { skew: { dataShareMin: 0.3 } } }).catalog;
    expect(types(tuned)).toEqual(['skew']);
  });

  it('reports a data tail once, as straggler, when tuning skew alone makes skew refuse it', () => {
    // 90% data share and P95/median 9: skew's defaults admit it as data.
    const data = tail({ dataMs: 90000, gcMs: 5000 });
    expect(types(analyzedRunFrom({ app, stages: stage(data) }).catalog)).toEqual(['skew']);
    for (const skew of [{ ratioWarn: 10 }, { dataShareMin: 0.95 }]) {
      const findings = analyzedRunFrom({ app, stages: stage(data) }, { thresholds: { skew } }).catalog;
      expect(types(findings)).toEqual(['straggler']);
      const [[name, value]] = Object.entries(skew);
      expect(findingOfType(findings, 'straggler').tunedThresholds).toEqual({ [`skew.${name}`]: { value, default: expect.any(Number) } });
    }
    expect(findingOfType(analyzedRunFrom({ app, stages: stage(data) }).catalog, 'skew').tunedThresholds).toBeUndefined();
  });

  it("keeps a data-driven tail only straggler's gate admits as a straggler finding, with the data volume", () => {
    // 4% of tasks over 4x P50 (a straggler tail), but P95/median is only 2x: skew's gate stays shut.
    const narrow = new Map([[1, makeTypedStage({
      taskCount: 100, completedAt: 5000, taskDurationP50: 1000, taskDurationP95: 2000, taskDurationMax: 40000,
      stragglerCount: 4, stragglerExcessMs: 120000, longestNonStragglerMs: 2000, peakConcurrentTasks: 10,
      tailAttribution: tail({ tasks: 4, dataMs: 90000, dataRatio: 12 }),
    })]]);
    const findings = analyzedRunFrom({ app, stages: narrow }).catalog;
    expect(types(findings)).toEqual(['straggler']);
    expect(findingOfType(findings, 'straggler')).toMatchObject({ cause: 'data', origin: expect.any(String) });
    expect(findingOfType(findings, 'straggler').recommendation).toContain('read a median 12× the data');
  });

  it("reports a non-data tail skew's gate admits but straggler's own gate does not, as a straggler", () => {
    // No task over 4x P50 (stragglerCount 0) but P95/median is 5x and the replayed tail clears the floor.
    const redirected = new Map([[1, makeTypedStage({
      taskCount: 100, completedAt: 50000, taskDurationP50: 1000, taskDurationP95: 5000, taskDurationMax: 5000,
      stragglerCount: 0, tailReplayRecoveryMs: 20000, peakConcurrentTasks: 10,
      tailAttribution: tail({ tasks: 8, gcMs: 80000 }),
    })]]);
    const findings = analyzedRunFrom({ app, stages: redirected }).catalog;
    expect(types(findings)).toEqual(['straggler']);
    expect(findingOfType(findings, 'straggler')).toMatchObject({ cause: 'gc', metric: 'P95/median', value: 5, unit: 'ratio' });
    expect(findingOfType(findings, 'straggler').recommendation).toContain('Task duration ratio (P95/median) is 5×: GC accounts for');
  });
});
