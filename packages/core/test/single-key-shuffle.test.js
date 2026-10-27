import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.ts';
import { analyze } from '../src/analyzer.ts';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

const MiB = 1024 * 1024;
const skewOf = (findings) => findings.find((f) => f.type === 'partitionSizing' && f.rule === 'shufflePartitionSkew');

// One 10-task stage: nine tasks read nothing and one reads 400 MiB.
describe('single-key shuffle in a hand-made log', () => {
  it('names the single key and drops the AQE and partition-count advice', async () => {
    const { appModel } = await collectRun(fileURLToPath(new URL('./fixtures/synthetic/single-key-shuffle.ndjson', import.meta.url)));
    const f = skewOf(analyze(appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed, appModel.jobs, appModel.sql, appModel.runAggregates));
    expect(f.singleKey).toBe(true);
    expect(f.recommendation).toContain('holds 100% of the stage\'s shuffle read');
    expect(f.recommendation).toContain('almost all rows share one key');
    expect(f.recommendation).not.toContain('AQE');
    expect(f.remediation).toEqual([{ kind: 'code', hint: expect.stringContaining('random key') }]);
  });
});

describe('single-key shuffle rule', () => {
  const run = (stage) => skewOf(analyze(makeApp(), new Map([[1, makeStage(stage)]]), [], []));
  const base = { shuffleReadP50: 0, shuffleReadMax: 360 * MiB, shuffleReadBytes: 400 * MiB, taskCount: 50 };

  it('fires at 90% of the stage read with an empty median', () => {
    expect(run(base).singleKey).toBe(true);
  });
  it('does not fire below 90%', () => {
    expect(run({ ...base, shuffleReadMax: 359 * MiB })).not.toHaveProperty('singleKey');
  });
  it('does not fire when the median partition holds data', () => {
    expect(run({ ...base, shuffleReadP50: MiB })).not.toHaveProperty('singleKey');
  });
});

describe('single-key shuffle next to a missed broadcast', () => {
  const small = 5 * MiB;
  const large = 20 * 1024 * MiB;
  const exchange = (bytes, id, stageIds) => ({
    name: 'Exchange', detail: 'Exchange hashpartitioning(k#1L, 200)', id: `r${id}`, exchangeRole: 'read', metrics: [], stageIds,
    children: [{ name: 'Exchange', detail: '', id: `w${id}`, exchangeRole: 'write', metrics: [{ name: 'data size', value: bytes, metricType: 'size' }], children: [], stageIds }],
  });
  const plan = (buildStageIds, streamStageIds) => ({
    name: 'SortMergeJoin', detail: 'SortMergeJoin [a#1L], [b#2L], Inner', metrics: [],
    children: [exchange(small, 'L', buildStageIds), exchange(large, 'R', streamStageIds)],
  });
  const findings = (config, buildStageIds = [0, 1], streamStageIds = buildStageIds, skewStage = 1) => {
    const stages = new Map([[skewStage, makeStage({ id: skewStage, shuffleReadP50: 0, shuffleReadMax: 400 * MiB, shuffleReadBytes: 400 * MiB, taskCount: 50, sqlExecutionId: 1 })]]);
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [skewStage], planTree: plan(buildStageIds, streamStageIds) }]]);
    return analyze(makeApp({ config, sparkVersion: '3.5.3' }), stages, [], [], new Map(), sql);
  };

  it('advises only a hint when the threshold already admits the small side', () => {
    expect(skewOf(findings()).recommendation).toContain('also has a missed broadcast: add a broadcast() hint.');
  });
  it('advises raising the threshold when it is below the small side', () => {
    const f = skewOf(findings({ 'spark.sql.autoBroadcastJoinThreshold': String(MiB) }));
    expect(f.recommendation).toContain('also has a missed broadcast: add a broadcast() hint or raise the threshold');
  });
  it('says automatic broadcast is disabled when the threshold is -1', () => {
    const f = skewOf(findings({ 'spark.sql.autoBroadcastJoinThreshold': '-1' }));
    expect(f.recommendation).toContain('automatic broadcast is disabled');
  });
  it('does not link a join whose stages are unknown, so only the whole execution is known', () => {
    const all = findings(undefined, null);
    expect(all.some((f) => f.type === 'underBroadcast')).toBe(true);
    expect(skewOf(all).recommendation).not.toContain('missed broadcast');
  });
  it('does not link a stage that only writes the join\'s input', () => {
    const all = findings(undefined, [0, 1], [0, 1], 0);
    expect(all.some((f) => f.type === 'underBroadcast')).toBe(true);
    expect(skewOf(all).recommendation).not.toContain('missed broadcast');
  });
  it('does not link when no side shows the stage that reads it', () => {
    const all = findings(undefined, [1], [2], 2);
    expect(all.some((f) => f.type === 'underBroadcast')).toBe(true);
    expect(skewOf(all).recommendation).not.toContain('missed broadcast');
  });
});
