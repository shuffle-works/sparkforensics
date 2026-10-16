import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { makeStage, makeApp, executorRow } from './fixtures/stage-app-fixtures.js';

// A deterministic spread of task durations around `centerMs`: `count` values whose ln runs evenly
// across +-`logSpread`, rotated by `offset` so executors don't all get the same set.
function spreadDurations(centerMs, count, logSpread, offset = 0) {
  return Array.from({ length: count }, (_, i) => {
    const slot = (i + offset) % count;
    const unit = count === 1 ? 0 : (2 * slot) / (count - 1) - 1;
    return Math.round(centerMs * Math.exp(logSpread * unit));
  });
}

// `executors` executors of `tasksEach` tasks over a 1000 s run, one stage of 900 s. The first
// executor's tasks run `slowdown` times longer than its peers', which all draw from the same spread.
function slowExecutorStage({ executors, tasksEach, logSpread, slowdown, centerMs = 100_000 }) {
  const rows = Array.from({ length: executors }, (_, i) => {
    const durations = spreadDurations(centerMs, tasksEach, logSpread, i);
    return executorRow(`exec-${i}`, i === 0 ? durations.map((d) => Math.round(d * slowdown)) : durations);
  });
  const app = makeApp({ startTime: 0, endTime: 1_000_000 });
  const stage = makeStage({
    taskCount: executors * tasksEach, submittedAt: 0, completedAt: 900_000, hostStats: [],
    executorStats: rows, taskDurationP50: centerMs,
  });
  return { app, stages: new Map([[1, stage]]) };
}

const taskTimeFindings = ({ app, stages }) =>
  analyze(app, stages, [], []).filter((f) => f.type === 'slowHost' && f.variant === 'multiDim' && f.dimension === 'taskTime');

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
    const stage = fixture.stages.get(1);
    // A second executor, slower still on its single task: one task is within the spread.
    stage.executorStats.push(executorRow('exec-lone', [Math.round(100_000 * 1.7)]));
    stage.taskCount += 1;
    const found = taskTimeFindings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0].executorId).toBe('exec-0');
  });

  describe('without a known spread', () => {
    const withoutSpread = (mutate) => {
      const fixture = slowExecutorStage({ executors: 10, tasksEach: 16, logSpread: 0.05, slowdown: 1.8 });
      expect(taskTimeFindings(fixture)).toHaveLength(1); // the control: flagged with the spread present
      fixture.stages.get(1).executorStats.forEach(mutate);
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

  it('keeps the byte dimensions on the plain ratio test', () => {
    const { app, stages } = slowExecutorStage({ executors: 10, tasksEach: 16, logSpread: 0.05, slowdown: 1 });
    stages.get(1).executorStats.forEach((e, i) => { e.inputBytes = i === 0 ? 200 * 1024 * 1024 : 20 * 1024 * 1024; delete e.logDurationM2; });
    const found = analyze(app, stages, [], []).filter((f) => f.type === 'slowHost' && f.dimension === 'inputBytes');
    expect(found).toHaveLength(1);
    expect(found[0].executorId).toBe('exec-0');
  });

  describe('on stages whose tasks are all alike', () => {
    // A seeded generator, so the stages and the count below never change between runs.
    function seededGaussian(seed) {
      let state = seed;
      const uniform = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      return () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
    }

    const flaggedShare = ({ executors, tasksEach, logSpread, stages = 300 }) => {
      const gaussian = seededGaussian(7 * executors + tasksEach);
      let flagged = 0;
      for (let s = 0; s < stages; s++) {
        const rows = Array.from({ length: executors }, (_, i) =>
          executorRow(`exec-${i}`, Array.from({ length: tasksEach }, () => Math.round(100_000 * Math.exp(logSpread * gaussian())))));
        const stage = makeStage({ taskCount: executors * tasksEach, submittedAt: 0, completedAt: 900_000, hostStats: [], executorStats: rows });
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
