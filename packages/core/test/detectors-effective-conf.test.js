import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

const MiB = 1024 * 1024;

function catalogOf(stages, app, sql = new Map()) {
  return analyze(app, new Map(stages.map((s) => [s.id, s])), [], [], new Map(), sql);
}

const join = () => ({ name: 'SortMergeJoin', detail: '', metrics: [], children: [
  { name: 'Exchange', detail: '', metrics: [], children: [] }, { name: 'Exchange', detail: '', metrics: [], children: [] },
] });
const sqlWith = (modifiedConfigs, planTree = join()) => new Map([[7, { id: 7, planTree, ...(modifiedConfigs ? { modifiedConfigs } : {}) }]]);

describe('detectors judge a SQL execution against the settings it ran with', () => {
  const lowParallelism = (config, modifiedConfigs, sparkVersion = '3.5.9') => catalogOf(
    [makeStage({ sqlExecutionId: 7, shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0 })],
    makeApp({ config, sparkVersion }), sqlWith(modifiedConfigs),
  ).find((f) => f.rule === 'lowShuffleParallelism');

  it('reads a per-query spark.sql.shuffle.partitions over the logged one', () => {
    // 2 GiB at 128 MiB per partition needs 16: the cluster's 200 is plenty, the query's 8 is not.
    expect(lowParallelism({ 'spark.sql.shuffle.partitions': '200', 'spark.sql.adaptive.enabled': 'false' }, undefined).partitions).toBe('ownPartitioning');
    const perQuery = lowParallelism({ 'spark.sql.shuffle.partitions': '200', 'spark.sql.adaptive.enabled': 'false' }, { 'spark.sql.shuffle.partitions': '8' });
    expect(perQuery.partitions).toBe('raise');
    expect(perQuery.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'increase', suggested: 16 }]);
  });

  it('does not let one execution\'s settings leak into a stage of another execution', () => {
    const stage = makeStage({ sqlExecutionId: 8, shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0 });
    const f = catalogOf([stage], makeApp({ config: { 'spark.sql.shuffle.partitions': '200', 'spark.sql.adaptive.enabled': 'false' } }), sqlWith({ 'spark.sql.shuffle.partitions': '8' }))
      .find((x) => x.rule === 'lowShuffleParallelism');
    expect(f.partitions).toBe('ownPartitioning');
  });

  it('recommends AQE skew-join handling for an execution that turned it off, though it defaults on', () => {
    const skewStage = makeStage({ sqlExecutionId: 7, taskDurationP50: 100, taskDurationP95: 600, shuffleReadBytes: 400 * MiB });
    const skew = (modifiedConfigs, config = {}) => catalogOf([skewStage], makeApp({ config, sparkVersion: '3.5.9' }), sqlWith(modifiedConfigs)).find((f) => f.type === 'skew');
    expect(skew(undefined).remediation).toEqual([{ kind: 'code', hint: 'salt the key or repartition on a better key' }]);
    const off = skew({ 'spark.sql.adaptive.skewJoin.enabled': 'false' });
    expect(off.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.adaptive.skewJoin.enabled', direction: 'set', suggested: true }]);
  });

  it('judges the broadcast against the execution\'s autoBroadcastJoinThreshold', () => {
    const tree = { name: 'BroadcastHashJoin', detail: '', metrics: [], children: [
      { name: 'BroadcastExchange', detail: '', id: 2, metrics: [{ name: 'data size', value: 2 * 1024 * MiB, metricType: 'size' }], children: [] },
    ] };
    const over = (modifiedConfigs) => catalogOf([], makeApp({ config: {} }), sqlWith(modifiedConfigs, tree)).find((f) => f.type === 'overBroadcast');
    // Spark's 10 MB default is below this 2 GiB broadcast, so only a hint can have forced it.
    expect(over(undefined).broadcastThreshold).toBe('notLimiting');
    expect(over({ 'spark.sql.autoBroadcastJoinThreshold': '4g' }).broadcastThreshold).toBe('limits');
    const off = over({ 'spark.sql.autoBroadcastJoinThreshold': '-1' });
    expect(off.broadcastThreshold).toBe('disabled');
    expect(off.remediation).toEqual([]);
  });
});

describe('speculation wording names the run\'s effective settings', () => {
  const waste = (app) => catalogOf([makeStage({ speculationWastedAttempts: 10, speculationWasteMs: 120_000 })], app).find((f) => f.type === 'speculationWaste');

  it('uses the Spark 3.x multiplier and quantile on 3.x and the 4.0 ones on 4.0', () => {
    expect(waste(makeApp({ sparkVersion: '3.5.9' })).recommendation)
      .toContain("(with this run's settings, a task running over 1.5x the median is relaunched once 75% of the stage's tasks have finished)");
    expect(waste(makeApp({ sparkVersion: '4.0.4' })).recommendation)
      .toContain("(with this run's settings, a task running over 3x the median is relaunched once 90% of the stage's tasks have finished)");
  });

  it('prefers the logged values over the version default', () => {
    const app = makeApp({ sparkVersion: '4.0.4', config: { 'spark.speculation.multiplier': '2', 'spark.speculation.quantile': '0.5' } });
    expect(waste(app).recommendation).toContain('over 2x the median is relaunched once 50% of');
  });

  it('says nothing about the trigger when the version is unknown and the values are not logged', () => {
    const f = waste(makeApp({ sparkVersion: null }));
    expect(f.recommendation).not.toMatch(/relaunched once/);
    expect(f.recommendation).toMatch(/consider tuning spark\.speculation\.multiplier\/quantile\.$/);
  });

  it('names them on a straggler driven by speculative attempts', () => {
    const stage = makeStage({ taskCount: 100, speculativeTasks: 40, taskDurationP50: 100, taskDurationP95: 300, taskDurationMax: 400_000, completedAt: 600_000 });
    const f = catalogOf([stage], makeApp({ sparkVersion: '4.0.4', endTime: 600_000 })).find((x) => x.type === 'straggler');
    expect(f.recommendation).toContain('40 speculative attempts discarded (with this run\'s settings, a task running over 3x the median');
  });

  it('names them on a slow-host finding, whether speculation is on or off', () => {
    const hostStats = [
      { host: 'a', taskCount: 20, totalDuration: 200000 }, { host: 'b', taskCount: 20, totalDuration: 200000 }, { host: 'c', taskCount: 20, totalDuration: 600000 },
    ];
    const slow = (config) => catalogOf([makeStage({ taskCount: 60, hostStats })], makeApp({ sparkVersion: '4.0.4', config })).find((f) => f.type === 'slowHost');
    expect(slow({}).recommendation).toContain("consider enabling spark.speculation to relaunch a lagging task automatically (with this run's settings, a task running over 3x the median");
    expect(slow({ 'spark.speculation': 'true' }).recommendation).toContain("speculation is already on, so a lagging task there is already relaunched (with this run's settings, a task running over 3x the median");
  });
});
