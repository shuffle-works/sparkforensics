import { describe, it, expect } from 'vitest';
import { buildComparison } from '../src/run-comparison.js';
import { comparisonVerdict } from '../src/comparison-verdict.js';
import { comparisonOutput } from '../src/comparison-output.js';
import { redactComparison } from '../src/redact.js';
import { makeStage } from './fixtures/stage-app-fixtures.js';

// A run of `executors` executors of 2 cores alive for the whole `wallMs` window, one stage that
// holds `taskMs` of task time and the given data volume.
function run({ id, wallMs, executors, taskMs, config = {}, stageName = 'scan', outputRows = 1000, inputBytes = 5000, outputBytes = 2000, startTime = 0 }) {
  const added = Array.from({ length: executors }, (_, i) => ({ executorId: String(i + 1), timestamp: startTime, totalCores: 2 }));
  return {
    label: id,
    catalog: [],
    appModel: {
      app: { id, name: 'Job', startTime, endTime: startTime + wallMs, config },
      stages: new Map([[1, makeStage({
        id: 1, name: stageName, submittedAt: startTime, completedAt: startTime + wallMs,
        executorRunTime: taskMs, inputBytes, outputBytes, outputRecords: outputRows,
      })]]),
      jobs: new Map(), sql: new Map(), executors: { added, removed: [] }, runAggregates: null,
    },
  };
}

const candRunWithExtraStage = () => {
  const cand = candRun();
  cand.appModel.stages.set(2, makeStage({ id: 2, name: 'only here', executorRunTime: 1000 }));
  return cand;
};
const SAME_CONF = { 'spark.sql.shuffle.partitions': '200', 'spark.executor.cores': '2' };
const baseRun = (over = {}) => run({ id: 'run-a', wallMs: 100_000, executors: 4, taskMs: 400_000, config: SAME_CONF, ...over });
// Fewer executors and less task time: slower overall, as a smaller allocation is.
const candRun = (over = {}) => run({ id: 'run-b', wallMs: 150_000, executors: 2, taskMs: 300_000, config: SAME_CONF, ...over });

describe('comparability', () => {
  it('reads equal runs with different capacity as equivalent and says where the time went', () => {
    const built = buildComparison(baseRun(), candRun());
    const { comparability: c } = built;
    expect(c.conf).toMatchObject({ equal: true, differences: [] });
    expect(c.plan).toEqual({ equal: true, unmatched: { baseline: 0, candidate: 0 }, replanned: 0 });
    expect(c.volume.equal).toBe(true);
    expect(c.capacity).toEqual({
      baseline: { meanExecutors: 4, peakExecutors: 4 },
      candidate: { meanExecutors: 2, peakExecutors: 2 },
    });
    expect(c.wallClockBridge.wallClock.ratio).toBeCloseTo(1.5);
    expect(c.wallClockBridge.taskTime.ratio).toBeCloseTo(0.75);
    expect(c.wallClockBridge.meanExecutors.ratio).toBeCloseTo(0.5);
    expect(c.wallClockBridge.taskShareOfAllocation.ratio).toBeCloseTo(1);
    expect(c.wallClockBridge.explainedWallClock).toBeCloseTo(1.5);
    const verdict = comparisonVerdict(built);
    expect(verdict.tone).toBe('equivalent');
    expect(verdict.title).toMatch(/^Same configuration, plan and output\. Time differs by 50\.0s \(50%\): executors averaged 4\.0 in the baseline and 2\.0 in the candidate, task time was /);
    expect(verdict.sentences.join(' ')).toMatch(/wall clock ×1\.50 is task time ×0\.75 divided by mean executors ×0\.50/);
    expect(`${verdict.title} ${verdict.sentences.join(' ')}`).not.toMatch(/no change/i);
  });

  it('states equal run time without a reason', () => {
    const verdict = comparisonVerdict(buildComparison(baseRun(), baseRun({ id: 'run-b' })));
    expect(verdict.tone).toBe('equivalent');
    expect(verdict.title).toBe('Same configuration, plan and output. The candidate took about as long as the baseline.');
  });

  it('lists configuration differences, leaving out identity keys, ignored keys and secrets', () => {
    const config = (over) => ({ ...SAME_CONF, ...over });
    const base = baseRun({ config: config({ 'spark.app.id': 'a', 'spark.out.path': '/x/1', 'spark.db.password': 'p1', 'spark.sql.shuffle.partitions': '200' }) });
    const cand = candRun({ config: config({ 'spark.app.id': 'b', 'spark.out.path': '/x/2', 'spark.db.password': 'p2', 'spark.sql.shuffle.partitions': '400', 'spark.extra': 'on' }) });
    const { conf } = buildComparison(base, cand, { ignoreConf: ['^spark\\.out\\.'] }).comparability;
    expect(conf.equal).toBe(false);
    expect(conf.differences).toEqual([
      { key: 'spark.extra', baseline: null, candidate: 'on' },
      { key: 'spark.sql.shuffle.partitions', baseline: '200', candidate: '400' },
    ]);
    expect(conf.ignoredKeys).toEqual(['spark.app.id', 'spark.out.path']);
    expect(conf.withheldKeys).toEqual(['spark.db.password']);
    expect(JSON.stringify(conf)).not.toMatch(/p1|p2/);
    expect(buildComparison(base, cand).comparability.conf.differences.map((d) => d.key)).toContain('spark.out.path');
  });

  it('withholds a key the run output withholds, with and without a user redact pattern', () => {
    const base = baseRun({ config: { ...SAME_CONF, 'spark.foo.internal.path': '/a', 'spark.db.password': 'p1' } });
    const cand = candRun({ config: { ...SAME_CONF, 'spark.foo.internal.path': '/b', 'spark.db.password': 'p2' } });
    const plain = buildComparison(base, cand).comparability.conf;
    expect(plain.withheldKeys).toEqual(['spark.db.password']);
    expect(plain.differences.map((d) => d.key)).toEqual(['spark.foo.internal.path']);
    const masked = buildComparison(base, cand, { confRedactRegex: 'internal' }).comparability.conf;
    expect(masked.withheldKeys).toEqual(['spark.db.password', 'spark.foo.internal.path']);
    expect(masked.differences).toEqual([]);
    expect(masked.equal).toBe(true);
    expect(JSON.stringify(masked)).not.toMatch(/"\/a"|"\/b"/);
  });

  it('does not read runs with different configuration as equivalent', () => {
    const built = buildComparison(baseRun(), candRun({ config: { ...SAME_CONF, 'spark.sql.shuffle.partitions': '400' } }));
    expect(comparisonVerdict(built).tone).not.toBe('equivalent');
  });

  it('leaves configuration equality unknown when a log records no Spark properties', () => {
    const built = buildComparison(baseRun(), candRun({ config: null }));
    expect(built.comparability.conf).toMatchObject({ equal: null, differences: [] });
    expect(comparisonVerdict(built).tone).not.toBe('equivalent');
  });

  it('counts unmatched stages and refuses equivalence when the plans differ', () => {
    const plan = buildComparison(
      baseRun(), { ...candRun(), appModel: { ...candRun().appModel, stages: new Map([[1, makeStage({ id: 1, name: 'x', executorRunTime: 1 })], [2, makeStage({ id: 2, name: 'only here', executorRunTime: 300_000 })]]) } },
    ).comparability.plan;
    expect(plan.equal).toBe(false);
    expect(plan.unmatched.baseline + plan.unmatched.candidate + plan.replanned).toBeGreaterThan(0);
    expect(comparisonVerdict(buildComparison(baseRun(), candRunWithExtraStage())).tone).not.toBe('equivalent');
  });

  it('reports volume differences and refuses equivalence when the output rows differ', () => {
    const built = buildComparison(baseRun(), candRun({ outputRows: 900, inputBytes: 5050 }));
    const { volume } = built.comparability;
    expect(volume.outputRows).toEqual({ baseline: 1000, candidate: 900, relativeDifference: -0.1 });
    expect(volume.inputBytes.relativeDifference).toBeCloseTo(0.01);
    expect(volume.equal).toBe(false);
    expect(comparisonVerdict(built).tone).not.toBe('equivalent');
  });

  it('accepts input and output bytes within the noise band but not beyond a wider difference', () => {
    expect(buildComparison(baseRun(), candRun({ outputBytes: 2020 })).comparability.volume.equal).toBe(true);
    expect(buildComparison(baseRun(), candRun({ outputBytes: 2200 })).comparability.volume.equal).toBe(false);
    expect(buildComparison(baseRun(), candRun({ outputBytes: 2200 }), { noiseBand: 0.2 }).comparability.volume.equal).toBe(true);
  });

  it('leaves volume equality unknown when neither run measured an output figure', () => {
    const built = buildComparison(baseRun({ outputRows: null, outputBytes: null }), candRun({ outputRows: null, outputBytes: null }));
    expect(built.comparability.volume.equal).toBeNull();
    const verdict = comparisonVerdict(built);
    expect(verdict.tone).toBe('worse');
    expect(verdict.title).toMatch(/^Same configuration and plan\. Output was not compared\./);
  });

  it('reads wall clock moving against task time as mixed when configuration differs', () => {
    const built = buildComparison(baseRun(), candRun({ config: { ...SAME_CONF, 'spark.sql.shuffle.partitions': '400' } }));
    const verdict = comparisonVerdict(built);
    expect(verdict.tone).toBe('mixed');
    expect(verdict.title).toMatch(/^The candidate finished 50\.0s slower than the baseline \(50%\), while executor run-time is 25% lower and allocated core-hours is 25% lower$/);
  });

  it('keeps the existing tones when the runs are not equivalent and cost moves with wall clock', () => {
    const other = { ...SAME_CONF, x: '1' };
    const slower = run({ id: 'run-b', wallMs: 150_000, executors: 4, taskMs: 500_000, config: other });
    expect(comparisonVerdict(buildComparison(baseRun(), slower)).tone).toBe('worse');
    expect(comparisonVerdict(buildComparison(slower, baseRun({ config: SAME_CONF }))).tone).toBe('better');
    expect(comparisonVerdict(buildComparison(baseRun(), baseRun({ id: 'run-b', config: other }))).tone).toBe('same');
  });

  it('measures the overlap of the two run windows', () => {
    expect(buildComparison(baseRun(), candRun()).comparability.overlapMs).toBe(100_000);
    expect(buildComparison(baseRun(), candRun({ startTime: 60_000 })).comparability.overlapMs).toBe(40_000);
    expect(buildComparison(baseRun(), candRun({ startTime: 500_000 })).comparability.overlapMs).toBe(0);
  });

  it('leaves the bridge null where a figure is unmeasured', () => {
    const noExecutors = baseRun();
    noExecutors.appModel.executors = { added: [], removed: [] };
    const { wallClockBridge } = buildComparison(noExecutors, candRun()).comparability;
    expect(wallClockBridge.meanExecutors.ratio).toBeNull();
    expect(wallClockBridge.explainedWallClock).toBeNull();
  });

  it('is part of the reported comparison and survives redaction', () => {
    const built = buildComparison(baseRun(), candRun());
    expect(comparisonOutput(built).comparability).toBe(built.comparability);
    expect(redactComparison(built).comparability).toEqual(built.comparability);
  });
});

describe('caveats', () => {
  const caveatsOf = (base, cand, opts) => buildComparison(base, cand, opts).comparability.caveats;

  it('flags mean executors that differ past the ratio, in either direction', () => {
    expect(caveatsOf(baseRun(), candRun()).executors).toEqual({ baseline: 4, candidate: 2 });
    expect(caveatsOf(candRun(), baseRun()).executors).toEqual({ baseline: 2, candidate: 4 });
    expect(caveatsOf(baseRun(), candRun({ executors: 3 })).executors).toBeNull();
    expect(caveatsOf(baseRun(), candRun(), { caveatThresholds: { executorRatio: 2 } }).executors).toBeNull();
  });

  it('reports a YARN queue difference and says it in the verdict', () => {
    const base = baseRun({ config: { ...SAME_CONF, 'spark.yarn.queue': 'root.a' } });
    const cand = candRun({ config: { ...SAME_CONF, 'spark.yarn.queue': 'root.b' } });
    expect(caveatsOf(base, cand).queue).toEqual({ baseline: 'root.a', candidate: 'root.b' });
    expect(caveatsOf(base, base).queue).toBeNull();
    expect(comparisonVerdict(buildComparison(base, cand)).sentences)
      .toContain('The YARN queue differs: root.a in the baseline, root.b in the candidate.');
  });

  it('flags unmatched baseline stages with their run-time share, and a task count change', () => {
    const cand = candRun({ stageName: 'a different stage' });
    const { unmatchedStages, taskCount } = caveatsOf(baseRun(), cand);
    expect(unmatchedStages).toEqual({ count: 1, of: 1, runtimeShare: 1 });
    expect(taskCount).toBeNull();
    expect(caveatsOf(baseRun(), cand, { caveatThresholds: { unmatchedShare: 1 } }).unmatchedStages).toBeNull();
    const taskCounts = (counts) => (run) => { run.appModel.stages.get(1).taskCount = counts; return run; };
    const change = caveatsOf(taskCounts(100)(baseRun()), taskCounts(60)(candRun())).taskCount;
    expect(change).toEqual({ baseline: 100, candidate: 60, change: -0.4 });
    expect(caveatsOf(taskCounts(100)(baseRun()), taskCounts(60)(candRun()), { caveatThresholds: { taskCountChange: 0.5 } }).taskCount).toBeNull();
  });

  it('counts the baseline stages a re-plan leaves over as unmatched', () => {
    const node = (name, detail, stageIds) => ({ name, detail, metrics: [], children: [], stageIds });
    const replanRun = (id, stageSpecs) => {
      const r = baseRun({ id });
      const children = [];
      r.appModel.stages = new Map(stageSpecs.map(({ id: stageId, name, nodes, executorRunTime }) => {
        children.push(...nodes);
        return [stageId, makeStage({ id: stageId, name, sqlExecutionId: 1, executorRunTime })];
      }));
      r.appModel.sql = new Map([[1, { id: 1, description: 'save at X.java:0', planTree: { name: 'Root', detail: '', metrics: [], children } }]]);
      return r;
    };
    const base = replanRun('run-a', [
      { id: 1, name: 'Exchange 1', nodes: [node('Scan parquet', 'a#1', [1]), node('Exchange', 'hashpartitioning(k#1, 200)', [1])], executorRunTime: 10 },
      { id: 2, name: 'Exchange 2', nodes: [node('Scan parquet', 'b#2', [2]), node('Exchange', 'hashpartitioning(k#2, 200)', [2])], executorRunTime: 20 },
      { id: 3, name: 'save at X.java:0', nodes: [node('SortMergeJoin', '[k#1], [k#2], Inner', [3])], executorRunTime: 30 },
    ]);
    const cand = replanRun('run-b', [
      { id: 1, name: 'Exchange 1', nodes: [node('Scan parquet', 'a#1', [1]), node('Exchange', 'hashpartitioning(k#1, 200)', [1])], executorRunTime: 10 },
      { id: 2, name: 'save at X.java:0', nodes: [node('BroadcastHashJoin', '[k#1], [k#2], Inner, BuildRight', [2])], executorRunTime: 12 },
    ]);
    const built = buildComparison(base, cand);
    expect(built.comparability.plan).toMatchObject({ unmatched: { baseline: 0, candidate: 0 }, replanned: 1 });
    expect(built.comparability.caveats.unmatchedStages).toEqual({ count: 1, of: 3, runtimeShare: 20 / 60 });
  });

  it('names a differing jar or Python file path as a likely code change', () => {
    const base = baseRun({ config: { ...SAME_CONF, 'spark.jars': '/jobs/a-1.jar', 'spark.yarn.dist.pyFiles': '/jobs/lib.zip' } });
    const cand = candRun({ config: { ...SAME_CONF, 'spark.jars': '/jobs/a-2.jar', 'spark.yarn.dist.pyFiles': '/jobs/lib.zip', 'spark.submit.pyFiles': '/jobs/x.py' } });
    expect(caveatsOf(base, cand).codeFiles).toEqual([
      { key: 'spark.jars', baseline: '/jobs/a-1.jar', candidate: '/jobs/a-2.jar' },
      { key: 'spark.submit.pyFiles', baseline: null, candidate: '/jobs/x.py' },
    ]);
    expect(caveatsOf(base, base).codeFiles).toBeNull();
    expect(comparisonVerdict(buildComparison(base, cand)).sentences)
      .toContain('The code may have changed: spark.jars, spark.submit.pyFiles differ. Compare with care.');
  });

  it('refuses a threshold outside its range', () => {
    for (const caveatThresholds of [{ executorRatio: 0.5 }, { unmatchedShare: 1.5 }, { taskCountChange: -1 }, { executorRatio: Number.NaN }]) {
      expect(() => buildComparison(baseRun(), candRun(), { caveatThresholds })).toThrow(/executorRatio|unmatchedShare|taskCountChange/);
    }
  });
});

describe('metric noise flag', () => {
  it('marks rows within the band without changing direction', () => {
    const rows = (opts) => Object.fromEntries(buildComparison(baseRun(), candRun({ taskMs: 404_000 }), opts).metrics.map((m) => [m.key, m]));
    expect(rows().executorRunTime).toMatchObject({ withinNoise: true, direction: 'regression' });
    expect(rows().wallClock).toMatchObject({ withinNoise: false, direction: 'regression' });
    expect(rows({ noiseBand: 0.6 }).wallClock).toMatchObject({ withinNoise: true, direction: 'regression' });
    expect(rows({ noiseBand: 0 }).executorRunTime.withinNoise).toBe(false);
  });

  it('refuses a noise band outside 0 to 1', () => {
    for (const noiseBand of [-0.1, 1.5, Number.NaN]) {
      expect(() => buildComparison(baseRun(), candRun(), { noiseBand })).toThrow(/noiseBand/);
    }
  });

  it('refuses an invalid, empty or over-long conf ignore pattern', () => {
    expect(() => buildComparison(baseRun(), candRun(), { ignoreConf: ['('] })).toThrow(/not a valid regular expression/);
    expect(() => buildComparison(baseRun(), candRun(), { ignoreConf: [''] })).toThrow(/non-empty/);
    expect(() => buildComparison(baseRun(), candRun(), { ignoreConf: ['a'.repeat(201)] })).toThrow(/limit/);
  });
});
