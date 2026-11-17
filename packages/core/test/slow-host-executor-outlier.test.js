import { describe, it, expect } from 'vitest';
import { analyzedRunFrom } from './fixtures/analyzed-run.js';
import { makeTypedStage, makeApp, executorRow } from './fixtures/stage-app-fixtures.js';

/** @typedef {import('../src/types.ts').Stage} Stage */
/** @typedef {Partial<Record<Exclude<keyof import('../src/stage-quantiles.ts').StageExecutorStat, 'executorId'>, number | null>>} LooseExecutorRow */

// A deterministic spread of task durations around `centerMs`: `count` values whose ln runs evenly
// across +-`logSpread`, rotated by `offset` so executors don't all get the same set.
/**
 * @param {number} centerMs
 * @param {number} count
 * @param {number} logSpread
 * @param {number} [offset]
 */
function spreadDurations(centerMs, count, logSpread, offset = 0) {
  return Array.from({ length: count }, (_, i) => {
    const slot = (i + offset) % count;
    const unit = count === 1 ? 0 : (2 * slot) / (count - 1) - 1;
    return Math.round(centerMs * Math.exp(logSpread * unit));
  });
}

// `executors` executors of `tasksEach` tasks over a 1000 s run, one stage of 900 s. The first
// executor's tasks run `slowdown` times longer than its peers', which all draw from the same spread.
/**
 * @param {{ executors: number, tasksEach: number, logSpread: number, slowdown: number, centerMs?: number }} shape
 * @returns {{ app: import('../src/types.ts').SparkAppInfo, stages: Map<number, Stage> }}
 */
function slowExecutorStage({ executors, tasksEach, logSpread, slowdown, centerMs = 100_000 }) {
  const rows = Array.from({ length: executors }, (_, i) => {
    const durations = spreadDurations(centerMs, tasksEach, logSpread, i);
    return executorRow(`exec-${i}`, i === 0 ? durations.map((d) => Math.round(d * slowdown)) : durations);
  });
  const app = makeApp({ startTime: 0, endTime: 1_000_000 });
  const stage = makeTypedStage({
    taskCount: executors * tasksEach, submittedAt: 0, completedAt: 900_000, hostStats: [],
    executorStats: rows, taskDurationP50: centerMs,
  });
  return { app, stages: new Map([[1, stage]]) };
}

/**
 * @param {import('../src/types.ts').Finding} f
 * @returns {f is import('../src/finding-types.ts').SlowHostMultiDimFinding}
 */
const isMultiDim = (f) => f.type === 'slowHost' && f.variant === 'multiDim';

/** @param {Map<number, Stage>} stages */
function firstStage(stages) {
  const stage = stages.get(1);
  if (!stage) throw new Error('stage 1 is missing');
  return stage;
}

/** @param {{ app: import('../src/types.ts').SparkAppInfo, stages: Map<number, Stage> }} fixture */
const taskTimeFindings = ({ app, stages }) =>
  analyzedRunFrom({ app, stages }).catalog.filter(isMultiDim).filter((f) => f.dimension === 'taskTime');

describe('slowHost task time: an executor must stand out from the stage\'s own spread', () => {
  it('does not flag the slowest of 75 executors whose tasks vary as much as the gap (chance outlier)', () => {
    // Every task spreads +-60% around the center, so one executor holding four slower draws is
    // what 75 executors produce on their own. Its mean is 1.7x the median.
    const fixture = slowExecutorStage({ executors: 75, tasksEach: 4, logSpread: 0.6, slowdown: 1.7 });
    expect(taskTimeFindings(fixture)).toEqual([]);
  });

  it('flags a consistently slow executor of 75 at the same 1.7x ratio and rates it critical', () => {
    // Tasks barely vary (+-5%) and the executor ran 12 of them: 1.7x cannot be chance.
    const fixture = slowExecutorStage({ executors: 75, tasksEach: 12, logSpread: 0.05, slowdown: 1.7 });
    const found = taskTimeFindings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0].executorId).toBe('exec-0');
    expect(found[0].value).toBe(1.7);
    expect(found[0].impactBand).toBe('critical');
  });

  it('asks for more evidence the more executors the slowest was picked from', () => {
    // The same 2x gap and spread: clear among 3 executors, noise among 75.
    const among3 = slowExecutorStage({ executors: 3, tasksEach: 20, logSpread: 0.3, slowdown: 2 });
    const among75 = slowExecutorStage({ executors: 75, tasksEach: 2, logSpread: 0.3, slowdown: 2 });
    expect(taskTimeFindings(among3)).toHaveLength(1);
    expect(taskTimeFindings(among75)).toEqual([]);
  });

  it('asks for more evidence from an executor that ran fewer tasks', () => {
    const many = slowExecutorStage({ executors: 10, tasksEach: 16, logSpread: 0.25, slowdown: 1.5 });
    const few = slowExecutorStage({ executors: 10, tasksEach: 1, logSpread: 0.25, slowdown: 1.5 });
    expect(taskTimeFindings(many)).toHaveLength(1);
    expect(taskTimeFindings(few)).toEqual([]);
  });

  it('reports the executor the spread rules out, not a slower one that ran too few tasks to tell', () => {
    const fixture = slowExecutorStage({ executors: 20, tasksEach: 10, logSpread: 0.3, slowdown: 1.6 });
    const stage = firstStage(fixture.stages);
    // A second executor, slower still on its single task: one task is within the spread.
    stage.executorStats.push(executorRow('exec-lone', [Math.round(100_000 * 1.7)]));
    stage.taskCount += 1;
    const found = taskTimeFindings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0].executorId).toBe('exec-0');
  });

  describe('without a known spread', () => {
    /** @param {(row: LooseExecutorRow) => void} mutate */
    const withoutSpread = (mutate) => {
      const fixture = slowExecutorStage({ executors: 10, tasksEach: 16, logSpread: 0.05, slowdown: 1.8 });
      expect(taskTimeFindings(fixture)).toHaveLength(1); // the control: flagged with the spread present
      firstStage(fixture.stages).executorStats.forEach(mutate);
      return fixture;
    };

    it('does not flag, and does not throw, when the log statistics are missing', () => {
      const fixture = withoutSpread((e) => { delete e.logDurationSum; delete e.logDurationM2; });
      expect(() => taskTimeFindings(fixture)).not.toThrow();
      expect(taskTimeFindings(fixture)).toEqual([]);
    });

    it('does not flag, and does not throw, when the log statistics are null or not finite', () => {
      for (const bad of [null, NaN, Infinity]) {
        const fixture = withoutSpread((e) => { e.logDurationM2 = bad; });
        expect(() => taskTimeFindings(fixture)).not.toThrow();
        expect(taskTimeFindings(fixture)).toEqual([]);
      }
    });

    it('does not flag when one executor alone lacks the statistics', () => {
      let first = true;
      const fixture = withoutSpread((e) => { if (first) { first = false; delete e.logDurationM2; } });
      expect(taskTimeFindings(fixture)).toEqual([]);
    });

    it('does not flag when every task took the same time', () => {
      const fixture = slowExecutorStage({ executors: 10, tasksEach: 16, logSpread: 0, slowdown: 1 });
      expect(taskTimeFindings(fixture)).toEqual([]);
    });
  });

  describe('byte dimensions compare per-task rates, not executor totals', () => {
    const MB = 1024 * 1024;
    /**
     * @param {string} dimension
     * @param {{ app: import('../src/types.ts').SparkAppInfo, stages: Map<number, Stage> }} fixture
     */
    const byteFindings = (dimension, { app, stages }) =>
      analyzedRunFrom({ app, stages }).catalog.filter(isMultiDim).filter((f) => f.dimension === dimension);

    // Three executors lived the whole stage (16 tasks each); seven were short-lived (2 tasks each).
    // Every task reads 10 MB, so the long-lived executors hold 8x the bytes at the same rate.
    /** @param {number} [outlierRate] bytes per task of the first long-lived executor */
    function mixedLifetimeStage(outlierRate = 10 * MB) {
      const { app, stages } = slowExecutorStage({ executors: 10, tasksEach: 2, logSpread: 0.05, slowdown: 1 });
      firstStage(stages).executorStats.forEach((/** @type {LooseExecutorRow} */ e, i) => {
        const long = i < 3;
        e.taskCount = long ? 16 : 2;
        e.inputBytes = e.taskCount * (i === 0 ? outlierRate : 10 * MB);
        e.shuffleReadBytes = e.inputBytes;
        e.shuffleWriteBytes = 0;
      });
      firstStage(stages).taskCount = 3 * 16 + 7 * 2;
      return { app, stages };
    }

    it('does not flag long-lived executors that read more bytes at the same per-task rate', () => {
      const fixture = mixedLifetimeStage();
      expect(byteFindings('inputBytes', fixture)).toEqual([]);
      expect(byteFindings('shuffleBytes', fixture)).toEqual([]);
    });

    it('flags an executor whose per-task rate is high, at info, with the median and executor count', () => {
      const found = byteFindings('inputBytes', mixedLifetimeStage(60 * MB));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ executorId: 'exec-0', value: 6, impactBand: 'info', executorCount: 10 });
      expect(found[0].execMaxValue).toBe(60 * MB);
      expect(found[0].medianValue).toBe(10 * MB);
    });

    it('leaves out executors that ran no task', () => {
      const { app, stages } = mixedLifetimeStage(60 * MB);
      firstStage(stages).executorStats.push(executorRow('exec-idle', []));
      const found = byteFindings('inputBytes', { app, stages });
      expect(found).toHaveLength(1);
      expect(found[0].executorCount).toBe(10);
    });
  });

  describe('on stages whose tasks are all alike', () => {
    // A seeded generator, so the stages and the count below never change between runs.
    /** @param {number} seed */
    function seededGaussian(seed) {
      let state = seed;
      const uniform = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      return () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
    }

    /** @param {{ executors: number, tasksEach: number, logSpread: number, stages?: number }} shape */
    const flaggedShare = ({ executors, tasksEach, logSpread, stages = 300 }) => {
      const gaussian = seededGaussian(7 * executors + tasksEach);
      let flagged = 0;
      for (let s = 0; s < stages; s++) {
        const rows = Array.from({ length: executors }, (_, i) =>
          executorRow(`exec-${i}`, Array.from({ length: tasksEach }, () => Math.round(100_000 * Math.exp(logSpread * gaussian())))));
        const stage = makeTypedStage({ taskCount: executors * tasksEach, submittedAt: 0, completedAt: 900_000, hostStats: [], executorStats: rows });
        if (taskTimeFindings({ app: makeApp({ startTime: 0, endTime: 1_000_000 }), stages: new Map([[1, stage]]) }).length > 0) flagged++;
      }
      return flagged / stages;
    };

    it.each([
      { executors: 3, tasksEach: 5, logSpread: 0.4 },
      { executors: 10, tasksEach: 5, logSpread: 0.7 },
      { executors: 75, tasksEach: 4, logSpread: 0.4 },
      { executors: 75, tasksEach: 4, logSpread: 0.7 },
    ])('flags under 1% of $executors-executor stages with a task spread of $logSpread', (shape) => {
      expect(flaggedShare(shape)).toBeLessThan(0.01);
    });
  });
});
