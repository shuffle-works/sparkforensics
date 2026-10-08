import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.ts';
import { analyze } from '../src/analyzer.ts';
import { effectiveSparkConf, overlayModifiedConfigs } from '../src/spark-conf.ts';
import { diagnoseJoinSkew, isSkewJoinNode } from '../src/aqe-skew.ts';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

const MiB = 1024 * 1024;
const KEY_REMEDY = 'salt the key or repartition on a better key';

// ---- plan builders (the shapes of Spark 3.5 and 4.0 final adaptive plans) ----

const node = (name, children = [], extra = {}) => ({ name, detail: extra.detail ?? name, metrics: extra.metrics ?? [], children, ...(extra.stageIds ? { stageIds: extra.stageIds } : {}) });
const exchange = (origin = 'ENSURE_REQUIREMENTS') => node('Exchange', [node('Exchange', [], { detail: '' })], { detail: `Exchange hashpartitioning(k#1L, 16), ${origin}, [plan_id=9]` });
const shuffleStage = (origin) => node('ShuffleQueryStage', [exchange(origin)], { detail: 'ShuffleQueryStage 0' });
const read = (detail, metrics = []) => (child) => node('AQEShuffleRead', [child], { detail: `AQEShuffleRead ${detail}`.trim(), metrics });
const codegen = (child) => node('WholeStageCodegen (3)', [node('Sort', [node('InputAdapter', [child])], { detail: 'Sort [k#1L ASC NULLS FIRST], false, 0' })]);
const side = (origin, aqeRead) => codegen(aqeRead ? aqeRead(shuffleStage(origin)) : shuffleStage(origin));
const join = (type, left, right, { name = 'SortMergeJoin', stageIds = [4] } = {}) => node(
  name, [node('InputAdapter', [left]), node('InputAdapter', [right])], { detail: `${name} [k#1L], [k#4L], ${type}`, stageIds });
const finalPlan = (root) => node('AdaptiveSparkPlan', [node('WholeStageCodegen (5)', [root], { stageIds: [4] })], { detail: 'AdaptiveSparkPlan isFinalPlan=true' });

const confOf = (config = {}, sparkVersion = '3.5.9') => (key) => effectiveSparkConf({ sparkVersion, properties: config }, key)?.value;
const diagnose = (plan, { readMax = 120 * MiB, readP50 = 2 * MiB, config = {}, stageId = 4, sparkVersion = '3.5.9' } = {}) => diagnoseJoinSkew({
  plan, stageId, readMax, readP50, conf: confOf(config, sparkVersion), sparkVersion, keyRemedy: KEY_REMEDY,
});
const plain = () => side('ENSURE_REQUIREMENTS');

describe('diagnoseJoinSkew on hand-built final plans', () => {
  it('reports a split from the join name and the skewed read, with the counts', () => {
    const skewedRead = read('skewed', [{ name: 'number of skewed partitions', value: 1 }, { name: 'number of skewed partition splits', value: 4 }]);
    const plan = finalPlan(join('Inner', side('ENSURE_REQUIREMENTS', skewedRead), side('ENSURE_REQUIREMENTS', read('')), { name: 'SortMergeJoin(skew=true)' }));
    const d = diagnose(plan, { readMax: 31 * MiB });
    expect(d.case).toBe('split');
    expect(d.text).toMatch(/already split 1 skewed partition into 4 tasks.*not join skew/);
    expect(d.remediation).toEqual([]);
  });

  it('reads a shuffled-hash join the same way (no Sort over the shuffle)', () => {
    const bare = (read_) => node('InputAdapter', [read_(shuffleStage('ENSURE_REQUIREMENTS'))]);
    const plan = finalPlan(node('ShuffledHashJoin(skew=true)', [bare(read('skewed')), bare(read(''))], { detail: 'ShuffledHashJoin(skew=true) [k#1L], [k#4L], Inner, BuildRight', stageIds: [4] }));
    expect(diagnose(plan).case).toBe('split');
    const unsplit = finalPlan(node('ShuffledHashJoin', [bare((c) => c), bare((c) => c)], { detail: 'ShuffledHashJoin [k#1L], [k#4L], Inner, BuildRight', stageIds: [4] }));
    expect(diagnose(unsplit, { config: { 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes': '4MB' } }).case).toBe('notSplit');
  });

  it('is below the threshold when the largest partition is under the effective one', () => {
    const plan = finalPlan(join('Inner', plain(), plain()));
    const d = diagnose(plan);
    expect(d.case).toBe('belowThreshold');
    expect(d.text).toMatch(/126 MB.*under the 256MB.*skewedPartitionThresholdInBytes/);
    expect(d.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes', direction: 'decrease', suggested: null }]);
  });

  it('names both when the partition is under the threshold and not far enough over the median', () => {
    const plan = finalPlan(join('Inner', plain(), plain()));
    const d = diagnose(plan, { readMax: 64 * MiB, readP50: 20 * MiB });
    expect(d.case).toBe('belowThreshold');
    expect(d.text).toMatch(/under the 256MB threshold.*and only 3\.2× the median, under the 5× factor.*lower both/);
    expect(d.remediation.map((r) => r.key)).toEqual(['spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes', 'spark.sql.adaptive.skewJoin.skewedPartitionFactor']);
  });

  it('uses the per-query threshold, and blames the factor when only the factor is not met', () => {
    const plan = finalPlan(join('Inner', plain(), plain()));
    const low = { 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes': '4MB' };
    // Over the 4 MiB threshold but under 5x the 30 MiB median.
    const d = diagnose(plan, { readMax: 100 * MiB, readP50: 30 * MiB, config: low });
    expect(d.case).toBe('belowThreshold');
    expect(d.text).toMatch(/only 3\.3× the median.*5×.*skewedPartitionFactor/);
    expect(d.remediation[0].key).toBe('spark.sql.adaptive.skewJoin.skewedPartitionFactor');
  });

  it('says the tail is not partition-size skew when the reads are even, with no threshold or factor advice', () => {
    const plan = finalPlan(join('Inner', plain(), plain()));
    for (const [readMax, readP50] of [[11 * MiB, 10 * MiB], [300 * MiB, 250 * MiB]]) {
      const d = diagnose(plan, { readMax, readP50 });
      expect(d.case).toBe('evenReads');
      expect(d.text).toMatch(/shuffle reads are even.*not partition-size skew/);
      expect(d.text).not.toMatch(/threshold|factor/);
      expect(d.remediation).toEqual([]);
    }
    expect(diagnose(plan, { readMax: 11 * MiB, readP50: 10 * MiB }).text).toContain('1.1× the median');
  });

  it('cannot tell when a coalesced read may be many small partitions', () => {
    const coalesced = side('ENSURE_REQUIREMENTS', read('coalesced'));
    const plan = finalPlan(join('Inner', coalesced, coalesced));
    // 2 MiB advisory size: a 3 MiB task is two partitions at most 1 MiB each.
    const cfg = { 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes': '1MB', 'spark.sql.adaptive.advisoryPartitionSizeInBytes': '2MB' };
    expect(diagnose(plan, { readMax: 3 * MiB, readP50: 3 * MiB, config: cfg })).toBeNull();
    expect(diagnose(plan, { readMax: 40 * MiB, readP50: 3 * MiB, config: cfg }).case).not.toBe('belowThreshold');
  });

  const low = { 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes': '4MB' };

  it('blames an aggregate or a window between the join and its shuffle', () => {
    const above = (name) => node('InputAdapter', [node(name, [node('WholeStageCodegen (3)', [node('Sort', [node('InputAdapter', [shuffleStage('ENSURE_REQUIREMENTS')])])])])]);
    const window = diagnose(finalPlan(node('SortMergeJoin', [above('Window'), node('InputAdapter', [plain()])], { detail: 'SortMergeJoin [k#1L], [k#4L], Inner', stageIds: [4] })), { config: low });
    expect(window.case).toBe('planShape');
    expect(window.text).toMatch(/left input comes from a window instead of a shuffle/);
    expect(window.remediation).toEqual([{ kind: 'code', hint: KEY_REMEDY }]);
    const aggregate = diagnose(finalPlan(node('SortMergeJoin', [node('InputAdapter', [plain()]), above('HashAggregate')], { detail: 'SortMergeJoin [k#1L], [k#4L], Inner', stageIds: [4] })), { config: low });
    expect(aggregate.text).toMatch(/right input comes from an aggregate/);
  });

  it('keeps an aggregate below the exchange out of the way', () => {
    const exchangeOverAggregate = node('ShuffleQueryStage', [node('Exchange', [node('SortAggregate', [], { detail: 'SortAggregate(key=[k#4L], functions=[first(pad2#13, false)])' })], { detail: 'Exchange hashpartitioning(k#4L, 16), ENSURE_REQUIREMENTS, [plan_id=9]' })]);
    const right = codegen(read('')(exchangeOverAggregate));
    expect(diagnose(finalPlan(join('Inner', plain(), right)), { config: low }).case).not.toBe('planShape');
  });

  it('blames a user repartition, and names a rebalance hint as one', () => {
    const user = diagnose(finalPlan(join('Inner', side('REPARTITION_BY_COL'), plain())), { config: low });
    expect(user.case).toBe('userRepartition');
    expect(user.text).toMatch(/a repartition you wrote feeds the join/);
    expect(user.remediation[0].kind).toBe('code');
    const rebalance = diagnose(finalPlan(join('Inner', plain(), side('REBALANCE_PARTITIONS_BY_COL'))), { config: low });
    expect(rebalance.text).toMatch(/a rebalance you wrote/);
  });

  it('blames the join type per Spark\'s splittable sides', () => {
    const plan = (type) => finalPlan(join(type, plain(), plain()));
    for (const type of ['FullOuter', 'ExistenceJoin(exists#7)']) {
      const d = diagnose(plan(type), { config: low });
      expect(d.case).toBe('joinType');
      expect(d.text).toMatch(/never splits either side/);
    }
    for (const [type, only, other] of [['LeftOuter', 'left', 'right'], ['LeftSemi', 'left', 'right'], ['LeftAnti', 'left', 'right'], ['RightOuter', 'right', 'left']]) {
      const d = diagnose(plan(type), { config: low });
      expect(d.case).toBe('joinType');
      expect(d.text).toContain(`only the ${only} side of a ${type} join, so a skewed partition on the ${other} side stays whole`);
    }
    for (const type of ['Inner', 'Cross']) expect(diagnose(plan(type), { config: low }).case).toBe('notSplit');
  });

  it('says AQE skipped the split when an operator above the join needs its partitioning', () => {
    const j = join('Inner', plain(), plain());
    const withAbove = (name, detail = name) => finalPlan(node(name, [node('WholeStageCodegen (5)', [j])], { detail }));
    for (const [name, detail, noun] of [
      ['SortAggregate', 'SortAggregate(key=[k#1L], functions=[max(pad#5)])', 'an aggregate'],
      ['Window', 'Window [row_number() ...]', 'a window'],
      ['SortMergeJoin', 'SortMergeJoin [k#1L], [k#8L], Inner', 'another join'],
    ]) {
      const d = diagnose(withAbove(name, detail), { config: low });
      expect(d.case).toBe('extraShuffle');
      expect(d.text).toContain(`${noun} above the join needs the join's partitioning`);
      expect(d.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.adaptive.forceOptimizeSkewedJoin', direction: 'set', suggested: true }]);
    }
  });

  it('gives the key remedy instead of forceOptimizeSkewedJoin before Spark 3.3, which has no such property', () => {
    const aggregateOver = (j) => finalPlan(node('SortAggregate', [node('WholeStageCodegen (5)', [j])], { detail: 'SortAggregate(key=[k#1L], functions=[max(pad#5)])' }));
    const extra = diagnose(aggregateOver(join('Inner', plain(), plain())), { config: low, sparkVersion: '3.2.1' });
    expect(extra.case).toBe('extraShuffle');
    expect(extra.text).toContain('an aggregate above the join needs the join\'s partitioning');
    expect(extra.text).not.toContain('forceOptimizeSkewedJoin');
    expect(extra.remediation).toEqual([{ kind: 'code', hint: KEY_REMEDY }]);
    const outer = diagnose(aggregateOver(join('LeftOuter', plain(), plain())), { config: low, sparkVersion: '3.2.1' });
    expect(outer.case).toBe('joinType');
    expect(outer.text).toMatch(/if the skew is on the left side, AQE skipped it because an aggregate above the join/);
    expect(outer.text).not.toContain('forceOptimizeSkewedJoin');
    expect(outer.remediation.map((x) => x.kind)).toEqual(['code']);
    for (const value of ['false', 'true']) {
      const logged = diagnose(aggregateOver(join('Inner', plain(), plain())), { config: { ...low, 'spark.sql.adaptive.forceOptimizeSkewedJoin': value }, sparkVersion: '3.2.1' });
      expect(logged.case).toBe('extraShuffle');
      expect(logged.remediation).toEqual([{ kind: 'code', hint: KEY_REMEDY }]);
    }
  });

  it('reads a logged forceOptimizeSkewedJoin on a run with no recorded Spark version', () => {
    const above = finalPlan(node('SortAggregate', [node('WholeStageCodegen (5)', [join('Inner', plain(), plain())])], { detail: 'SortAggregate(key=[k#1L], functions=[max(pad#5)])' }));
    const unversioned = (config) => diagnoseJoinSkew({
      plan: above, stageId: 4, readMax: 120 * MiB, readP50: 2 * MiB, conf: (key) => config[key], sparkVersion: null, keyRemedy: KEY_REMEDY,
    });
    expect(unversioned({ 'spark.sql.adaptive.forceOptimizeSkewedJoin': 'true' }).case).toBe('notSplit');
    const notForced = unversioned({ 'spark.sql.adaptive.forceOptimizeSkewedJoin': 'false' });
    expect(notForced.case).toBe('extraShuffle');
    expect(notForced.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.adaptive.forceOptimizeSkewedJoin', direction: 'set', suggested: true }]);
    const unlogged = unversioned({});
    expect(unlogged.case).toBe('extraShuffle');
    expect(unlogged.remediation).toEqual([{ kind: 'code', hint: KEY_REMEDY }]);
  });

  it('does not blame the extra shuffle for a partial aggregate, an exchange above, or a forced run', () => {
    const j = join('Inner', plain(), plain());
    const partial = finalPlan(node('SortAggregate', [node('WholeStageCodegen (5)', [j])], { detail: 'SortAggregate(key=[k#1L], functions=[partial_max(pad#5)])' }));
    expect(diagnose(partial, { config: low }).case).toBe('notSplit');
    const exchanged = finalPlan(node('SortAggregate', [node('ShuffleQueryStage', [node('Exchange', [node('WholeStageCodegen (5)', [j])], { detail: 'Exchange hashpartitioning(k#1L, 16)' })])], { detail: 'SortAggregate(key=[k#1L], functions=[max(pad#5)])' }));
    expect(diagnose(exchanged, { config: low }).case).toBe('notSplit');
    const above = finalPlan(node('SortAggregate', [node('WholeStageCodegen (5)', [j])], { detail: 'SortAggregate(key=[k#1L], functions=[max(pad#5)])' }));
    expect(diagnose(above, { config: { ...low, 'spark.sql.adaptive.forceOptimizeSkewedJoin': 'true' } }).case).toBe('notSplit');
  });

  it('adds the extra-shuffle cause to a one-sided join type when an operator above needs the partitioning', () => {
    const above = finalPlan(node('SortAggregate', [node('WholeStageCodegen (5)', [join('LeftOuter', plain(), plain())])], { detail: 'SortAggregate(key=[k#1L], functions=[max(pad#5)])' }));
    const d = diagnose(above, { config: low });
    expect(d.case).toBe('joinType');
    expect(d.text).toMatch(/only the left side.*if the skew is on the left side, AQE skipped it because an aggregate above the join/);
    expect(d.remediation.map((r) => r.kind)).toEqual(['code', 'conf']);
  });

  it('returns null when the plan cannot say', () => {
    const j = join('Inner', plain(), plain());
    expect(diagnose(null)).toBeNull();
    expect(diagnose(node('AdaptiveSparkPlan', [j], { detail: 'AdaptiveSparkPlan isFinalPlan=false' }))).toBeNull();
    expect(diagnose(node('SortMergeJoin', [], { detail: 'SortMergeJoin [k#1L], [k#4L], Inner' }))).toBeNull();
    // Joins tied to other stages only.
    expect(diagnose(finalPlan(j), { stageId: 9 })).toBeNull();
    // Two joins, none tied to a stage: no guess.
    const untied = (stageIds) => join('Inner', plain(), plain(), { stageIds });
    expect(diagnose(finalPlan(node('SortMergeJoin', [node('InputAdapter', [untied(null)]), node('InputAdapter', [untied(null)])], { detail: 'SortMergeJoin [k#1L], [k#4L], Inner' })))).toBeNull();
  });

  it('reads the only join of a plan whose nodes carry no stage ids', () => {
    expect(diagnose(finalPlan(join('Inner', plain(), plain(), { stageIds: null })), { config: low }).case).toBe('notSplit');
  });

  it('prefers a join that split when a stage runs two', () => {
    const skewedRead = read('skewed');
    const split = join('Inner', side('ENSURE_REQUIREMENTS', skewedRead), plain(), { name: 'SortMergeJoin(skew=true)' });
    const unsplit = join('FullOuter', plain(), plain());
    const root = node('SortMergeJoin', [node('InputAdapter', [unsplit]), node('InputAdapter', [split])], { detail: 'SortMergeJoin [k#1L], [k#4L], Inner', stageIds: [4] });
    expect(diagnose(finalPlan(root), { config: low }).case).toBe('split');
  });
});

describe('join recognition', () => {
  it('matches the join names Spark prints, with and without the skew marker', () => {
    expect(['SortMergeJoin', 'SortMergeJoin(skew=true)', 'ShuffledHashJoin', 'ShuffledHashJoin(skew=true)'].every(isSkewJoinNode)).toBe(true);
    expect(['BroadcastHashJoin', 'BroadcastNestedLoopJoin', 'HashAggregate'].some(isSkewJoinNode)).toBe(false);
  });
});

// ---- real Spark logs ----
// Each log is a local Spark run with three queries over a key holding 60% of the rows, joined to a
// small table with broadcast off, 16 shuffle partitions and runtime skew settings: execution 0 an
// inner join AQE split, execution 1 a left outer join with the skew on the right side, execution 2
// an inner join whose big side went through repartition("k"). The queries and the way the logs were
// trimmed are in testing.md#test-fixtures.
const LOGS = [
  ['3.5.9', fileURLToPath(new URL('./fixtures/aqe-skew-spark-3.5.ndjson', import.meta.url))],
  ['4.0.4', fileURLToPath(new URL('./fixtures/aqe-skew-spark-4.0.ndjson', import.meta.url))],
];

describe.each(LOGS)('AQE skew handling in a real Spark %s log', (version, path) => {
  const loaded = collectRun(path);
  const joinStageOf = (appModel, executionId) => [...appModel.stages.values()]
    .filter((s) => s.sqlExecutionId === executionId).sort((a, b) => b.shuffleReadBytes - a.shuffleReadBytes)[0];

  it('names the split, the join type and the user repartition from the final plans', async () => {
    const { appModel } = await loaded;
    expect(appModel.app.sparkVersion).toBe(version);
    const diagnoseExecution = (id) => {
      const sql = appModel.sql.get(id);
      const stage = joinStageOf(appModel, id);
      const config = overlayModifiedConfigs(appModel.app.config, sql.modifiedConfigs);
      return diagnoseJoinSkew({
        plan: sql.planTree, stageId: stage.id, readMax: stage.shuffleReadMax, readP50: stage.shuffleReadP50,
        conf: (key) => effectiveSparkConf({ sparkVersion: version, properties: config }, key)?.value, sparkVersion: version, keyRemedy: KEY_REMEDY,
      });
    };
    expect(diagnoseExecution(0).case).toBe('split');
    expect(diagnoseExecution(0).text).toMatch(/already split 1 skewed partition into \d+ tasks/);
    expect(diagnoseExecution(1)).toMatchObject({ case: 'joinType' });
    expect(diagnoseExecution(1).text).toContain('only the left side of a LeftOuter join');
    expect(diagnoseExecution(2).case).toBe('userRepartition');
  });

  it('carries the case on the skew and straggler findings, and as evidence', async () => {
    const { appModel } = await loaded;
    const findings = analyze(appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed, appModel.jobs, appModel.sql, appModel.runAggregates);
    const byStage = (type, executionId) => findings.find((f) => f.type === type && f.stageId === joinStageOf(appModel, executionId).id);
    const outer = byStage('skew', 1);
    expect(outer).toMatchObject({ origin: 'shuffleJoin', aqeSkew: 'joinType' });
    expect(outer.recommendation).toContain('LeftOuter');
    expect(outer.recommendation).not.toContain('already on');
    expect(byStage('skew', 2)).toMatchObject({ origin: 'shuffleJoin', aqeSkew: 'userRepartition' });
    expect(byStage('straggler', 2).recommendation).toMatch(/if uneven data is the cause, a repartition you wrote feeds the join/);
  });
});

describe('skew findings on a hand-built final plan', () => {
  const sqlOf = (planTree, modifiedConfigs) => new Map([[7, { id: 7, planTree, ...(modifiedConfigs ? { modifiedConfigs } : {}) }]]);
  const skewStage = makeStage({
    sqlExecutionId: 7, id: 4, taskDurationP50: 100, taskDurationP95: 600, taskCount: 40,
    shuffleReadBytes: 400 * MiB, shuffleReadP50: 2 * MiB, shuffleReadMax: 120 * MiB,
  });
  const run = (app, sql) => analyze(app, new Map([[4, skewStage]]), [], [], new Map(), sql);
  const plan = finalPlan(join('Inner', plain(), plain()));

  it('words a partition under the default threshold, and a lowered per-query one lets it through', () => {
    const app = makeApp({ config: {}, sparkVersion: '3.5.9' });
    const part = run(app, sqlOf(plan)).find((f) => f.type === 'skew');
    expect(part).toMatchObject({ origin: 'shuffleJoin', aqeSkew: 'belowThreshold' });
    expect(part.recommendation).toMatch(/under the 256MB.*lower the threshold for this query/);
    const lowered = run(app, sqlOf(plan, { 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes': '4MB' })).find((f) => f.type === 'skew');
    expect(lowered.aqeSkew).toBe('notSplit');
  });

  it('keeps the enable advice when the execution turned skew-join handling off, and the AQE-off advice', () => {
    const app = makeApp({ config: {}, sparkVersion: '3.5.9' });
    const off = run(app, sqlOf(plan, { 'spark.sql.adaptive.skewJoin.enabled': 'false' })).find((f) => f.type === 'skew');
    expect(off.aqeSkew).toBeUndefined();
    expect(off.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.adaptive.skewJoin.enabled', direction: 'set', suggested: true }]);
    const aqeOff = run(makeApp({ config: { 'spark.sql.adaptive.enabled': 'false' }, sparkVersion: '3.5.9' }), sqlOf(plan)).find((f) => f.type === 'skew');
    expect(aqeOff.aqeSkew).toBeUndefined();
    expect(aqeOff.recommendation).toMatch(/AQE is off/);
  });

  it('puts the case on partitionSizing and straggler, and in the evidence report', () => {
    const app = makeApp({ config: {}, sparkVersion: '3.5.9' });
    const stage = makeStage({ ...skewStage, shuffleReadMax: 300 * MiB, stragglerCount: 8, speculativeTasks: 0 });
    const findings = analyze(app, new Map([[4, stage]]), [], [], new Map(), sqlOf(plan));
    expect(findings.find((f) => f.rule === 'shufflePartitionSkew')).toMatchObject({ origin: 'shuffleJoin', aqeSkew: 'notSplit' });
    expect(findings.find((f) => f.type === 'straggler')).toMatchObject({ origin: 'shuffleJoin', aqeSkew: 'notSplit' });
  });

  it('gives a duration tail over even shuffle reads no threshold or factor advice', () => {
    const app = makeApp({ config: {}, sparkVersion: '3.5.9' });
    const even = makeStage({ ...skewStage, shuffleReadP50: 10 * MiB, shuffleReadMax: 11 * MiB });
    const f = analyze(app, new Map([[4, even]]), [], [], new Map(), sqlOf(plan)).find((x) => x.type === 'skew');
    expect(f).toMatchObject({ origin: 'shuffleJoin', aqeSkew: 'evenReads', value: 6, remediation: [] });
    expect(f.recommendation).toMatch(/shuffle reads are even.*not partition-size skew/);
    expect(f.recommendation).not.toMatch(/threshold|factor/);
  });
});
