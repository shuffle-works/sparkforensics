import { describe, it, expect } from 'vitest';
import { auditConfig } from '../src/analyzer.js';
import { analyzedRunFrom } from './fixtures/analyzed-run.js';
import { buildEvidenceReport } from '../src/evidence-report.js';
import { recommendationParts } from '../src/finding-names.js';
import { coreFindingGenericRecommendation } from '../src/finding-generic-recommendation.ts';
import { makeTypedStage, makeApp, dataTail } from './fixtures/stage-app-fixtures.js';

const MiB = 1024 * 1024;
const KRYO = 'org.apache.spark.serializer.KryoSerializer';

/** @typedef {import('../src/types.ts').Finding} Finding */
/** @typedef {import('../src/types.ts').Stage} Stage */
/** @typedef {import('../src/types.ts').SqlExecution} SqlExecution */
/** @typedef {import('../src/types.ts').PlanNode} PlanNode */
/** @typedef {import('../src/types.ts').AppResources} AppResources */
/** @typedef {import('../src/types.ts').AppModel} AppModel */
/** @typedef {import('../src/finding-types.ts').Remediation} Remediation */
/** @typedef {import('../src/finding-types.ts').PartitionSizingFinding} PartitionSizingFinding */
/** @typedef {ReturnType<typeof makeApp>} App */
/** @typedef {Record<string, string>} Config */
/** @typedef {import('../src/types.ts').AppModel['executors']['added'][number]} ExecutorAdded */
/** @typedef {import('../src/types.ts').AppModel['executors']['removed'][number]} ExecutorRemoved */
/** @typedef {Map<number, SqlExecution>} SqlMap */

/**
 * @template T
 * @param {T | null | undefined} value
 * @returns {T}
 */
function present(value) {
  if (value == null) throw new Error('expected a value');
  return value;
}

/**
 * A `find` predicate that narrows to one finding type.
 * @template {Finding['type']} T
 * @param {T} type
 */
function ofType(type) {
  /** @param {Finding} f @returns {f is Extract<Finding, { type: T }>} */
  return (f) => f.type === type;
}

/**
 * A `find` predicate that narrows to one partitionSizing rule.
 * @param {PartitionSizingFinding['rule']} rule
 */
function ofRule(rule) {
  /** @param {Finding} f @returns {f is PartitionSizingFinding} */
  return (f) => f.type === 'partitionSizing' && f.rule === rule;
}

/** An executor-added event holding only the fields the detectors read. */
const addedExecutor = (/** @type {string} */ executorId, /** @type {number} */ timestamp, /** @type {number} */ totalCores) =>
  /** @type {ExecutorAdded} */ ({ executorId, timestamp, totalCores });

/** An executor-removed event holding only the fields the detectors read. */
const removedExecutor = (/** @type {string} */ executorId, /** @type {number} */ timestamp) =>
  /** @type {ExecutorRemoved} */ ({ executorId, timestamp });

/**
 * A `find` predicate for the configAudit finding that names a property.
 * @param {string} property
 */
const ofProperty = (property) => (/** @type {Finding} */ f) => f.type === 'configAudit' && f.property === property;

/** The property a conf remediation names; a code remediation names none. */
const remedyKey = (/** @type {Remediation} */ r) => (r.kind === 'conf' ? r.key : undefined);

/**
 * @param {Stage[]} stages
 * @param {App} [app]
 * @param {SqlMap} [sql]
 */
function catalogOf(stages, app = makeApp(), sql = new Map()) {
  return analyzedRunFrom({ app, stages: new Map(stages.map((s) => [s.id, s])), sql }).catalog;
}

// What a skew finding with no property to set reports: the fix is in the job's code or data.
const SKEW_CODE_FIX = [{ kind: 'code', hint: 'salt the key or repartition on a better key' }];

// A SQL execution whose plan joins two exchanges: the shape AQE skew-join handling acts on.
/** @type {SqlMap} */
const JOIN_SQL = new Map([[7, { id: 7, planTree: { name: 'SortMergeJoin', detail: '', metrics: [], children: [
  { name: 'Exchange', detail: '', metrics: [], children: [] }, { name: 'Exchange', detail: '', metrics: [], children: [] },
] } }]]);

describe('structured remediation', () => {
  describe('lowShuffleParallelism against the effective shuffle partition count', () => {
    // An unknown Spark version has no AQE default, so the stage's own tasks are not read as coalesced.
    const finding = (/** @type {Config} */ config, /** @type {string | null} */ sparkVersion = null, /** @type {number | null} */ sqlExecutionId = 1) => present(catalogOf(
      [makeTypedStage({ shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0, sqlExecutionId })],
      makeApp({ config, sparkVersion }),
    ).find(ofRule('lowShuffleParallelism')));
    const run = (/** @type {Config} */ config, /** @type {string | null} */ sparkVersion = null) => finding(config, sparkVersion).remediation;
    const increase = (/** @type {number} */ suggested) => [{ kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'increase', suggested }];

    it('suggests the count that reaches the ideal partition size when the logged value is below it', () => {
      // 2 GiB / 128 MiB
      expect(run({ 'spark.sql.shuffle.partitions': '8' })).toEqual(increase(16));
      expect(finding({ 'spark.sql.shuffle.partitions': '8' }).partitions).toBe('raise');
    });

    it('treats the unlogged default of 200 as the effective count', () => {
      const unlogged = finding({});
      expect(unlogged.remediation).toEqual([]);
      expect(unlogged.partitions).toBe('ownPartitioning');
      expect(unlogged.recommendation).toMatch(/\(200\) did not size this stage's 5 tasks.*repartition\(n\)/);
      // A 200-partition default is too few for 40 GiB: 40 GiB / 128 MiB = 320.
      const big = present(catalogOf(
        [makeTypedStage({ shuffleReadBytes: 40 * 1024 * MiB, taskCount: 5 })], makeApp({ config: {}, sparkVersion: null }),
      ).find(ofRule('lowShuffleParallelism')));
      expect(big.remediation).toEqual(increase(320));
    });

    it('suggests nothing when the effective value is already at or above the count, since it does not limit that stage', () => {
      expect(run({ 'spark.sql.shuffle.partitions': '200' })).toEqual([]);
      expect(run({ 'spark.sql.shuffle.partitions': '16' })).toEqual([]);
    });

    it('points the text at the stage\'s own partitioning, not the property, when the effective value is already enough', () => {
      const { recommendation } = finding({ 'spark.sql.shuffle.partitions': '200' });
      expect(recommendation).not.toMatch(/raise spark\.sql\.shuffle\.partitions/);
      expect(recommendation).toMatch(/repartition\(n\)/);
      expect(finding({ 'spark.sql.shuffle.partitions': '8' }).recommendation).toMatch(/raise spark\.sql\.shuffle\.partitions/);
    });

    it('points at the advisory partition size when AQE coalesced the shuffle into few tasks', () => {
      const f = finding({}, '3.5.3');
      expect(f.partitions).toBe('aqeCoalesced');
      expect(f.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.adaptive.advisoryPartitionSizeInBytes', direction: 'decrease', suggested: null }]);
      expect(coreFindingGenericRecommendation(f)).toMatch(/advisoryPartitionSizeInBytes/);
      // A stage outside any SQL execution is never coalesced by AQE.
      expect(finding({}, '3.5.3', null).partitions).toBe('ownPartitioning');
      // AQE off or coalescing off: the property is again the question.
      expect(finding({ 'spark.sql.adaptive.enabled': 'false' }, '3.5.3').partitions).toBe('ownPartitioning');
      expect(finding({ 'spark.sql.adaptive.coalescePartitions.enabled': 'false' }, '3.5.3').partitions).toBe('ownPartitioning');
    });
  });

  it('gives autoscalingChurn a remediation for the idle timeout and each bound its text names', () => {
    const added = Array.from({ length: 10 }, (_, i) => addedExecutor(String(i + 1), 0, 1));
    const removed = added.map((e) => removedExecutor(e.executorId, 60_000));
    const churn = present(analyzedRunFrom({ app: makeApp({ startTime: 0, endTime: 600_000, config: { 'spark.dynamicAllocation.enabled': 'true' } }), executors: { added: added, removed: removed } }).catalog
      .find(ofType('autoscalingChurn')));
    expect(churn.recommendation).toMatch(/executorIdleTimeout or widening the minExecutors\/maxExecutors bounds/);
    expect(churn.remediation).toEqual([
      { kind: 'conf', key: 'spark.dynamicAllocation.executorIdleTimeout', direction: 'increase', suggested: null },
      { kind: 'conf', key: 'spark.dynamicAllocation.minExecutors', direction: 'decrease', suggested: null },
      { kind: 'conf', key: 'spark.dynamicAllocation.maxExecutors', direction: 'increase', suggested: null },
    ]);
  });

  describe('coldStart dynamic allocation remediation', () => {
    const coldStart = (/** @type {App} */ app) => present(analyzedRunFrom({ app, stages: new Map([[1, makeTypedStage({ id: 1, submittedAt: 60_000, completedAt: 70_000 })]]), executors: { added: [addedExecutor('1', 120_000, 4)], removed: [] } }).catalog.find(ofType('coldStart')));
    /**
     * @param {Config} config
     * @param {{ dynamicAllocationEnabled: boolean }} [resources]
     */
    const app = (config, resources) => makeApp({ endTime: 200_000, config, resources });

    it('suggests raising min and initial executors only when dynamic allocation is on', () => {
      for (const a of [app({ 'spark.dynamicAllocation.enabled': 'true' }), app({ 'spark.dynamicAllocation.enabled': 'true' }, { dynamicAllocationEnabled: true })]) {
        expect(present(coldStart(a).remediation).map(remedyKey)).toEqual([
          'spark.dynamicAllocation.minExecutors', 'spark.dynamicAllocation.initialExecutors',
        ]);
      }
    });

    it('suggests nothing when the logged conf has dynamic allocation off', () => {
      expect(coldStart(app({ 'spark.dynamicAllocation.enabled': 'false' }, { dynamicAllocationEnabled: false })).remediation).toEqual([]);
      expect(coldStart(app({ 'spark.dynamicAllocation.enabled': 'FALSE' })).remediation).toEqual([]);
      // Unset is off, as Spark defaults it, so cold start agrees with the idle-capacity finding.
      expect(coldStart(app({})).remediation).toEqual([]);
    });
  });

  it('lowers shuffle partitions for a tinyTask finding on a shuffle stage with no suggested value, and none off one', () => {
    // 200 tasks: the effective spark.sql.shuffle.partitions, so the property sized the stage.
    const tiny = { taskCount: 200, taskDurationP50: 80, taskDurationP95: 150 };
    const onShuffle = present(catalogOf([makeTypedStage({ ...tiny, shuffleReadBytes: 10 * MiB })]).find(ofType('tinyTask')));
    expect(onShuffle.remediation).toEqual([
      { kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'decrease', suggested: null },
    ]);
    const noShuffle = present(catalogOf([makeTypedStage(tiny)]).find(ofType('tinyTask')));
    expect(noShuffle.remediation).toEqual([]);
  });

  it('leaves suggested null where the detector computes no value', () => {
    // One 200 MiB task is over the ideal partition size, and the logged count of 1 limits it.
    const app = makeApp({ config: { 'spark.sql.shuffle.partitions': '1', 'spark.sql.adaptive.enabled': 'false' } });
    const f = present(catalogOf([makeTypedStage({ shuffleReadBytes: 200 * MiB, taskCount: 1 })], app).find(ofType('shuffle')));
    expect(f.partitions).toBe('raise');
    expect(f.remediation).toEqual([
      { kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'increase', suggested: null },
    ]);
  });

  it('gives a skew-driven spill no remediation, since more memory will not help', () => {
    const f = present(catalogOf([makeTypedStage({ memoryBytesSpilled: 2048 * MiB, spillClassification: 'skew' })]).find(ofType('spill')));
    expect(f.remediation).toEqual([]);
  });

  it('names the serializer class and the memoryOverhead floor from the audited config', () => {
    const app = {
      config: { 'spark.executor.memory': '10g', 'spark.executor.memoryOverhead': '256' },
      resources: /** @type {AppResources} */ ({ executor: { memoryMB: 10240, memoryOverheadMB: 256 }, driver: {}, serializer: null }),
    };
    const findings = auditConfig(app, new Map([[1, makeTypedStage()]]));
    expect(present(findings.find(ofProperty('spark.serializer'))).remediation).toEqual([
      { kind: 'conf', key: 'spark.serializer', direction: 'set', suggested: KRYO },
    ]);
    expect(present(findings.find(ofProperty('spark.executor.memoryOverhead'))).remediation).toEqual([
      { kind: 'conf', key: 'spark.executor.memoryOverhead', direction: 'increase', suggested: '1024m' },
    ]);
  });

  it('carries a remediation entry for every property a recommendation names', () => {
    const findings = [
      ...catalogOf([
        makeTypedStage({ id: 1, sqlExecutionId: 1, shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0, gcPct: 40, jvmGCTime: 4000, memoryBytesSpilled: 3000 * MiB }),
        makeTypedStage({ id: 2, taskCount: 200, taskDurationP50: 80, taskDurationP95: 150, shuffleReadBytes: 10 * MiB }),
        makeTypedStage({ id: 3, taskDurationP50: 100, taskDurationP95: 900, taskDurationMax: 2000 }),
        makeTypedStage({ id: 4, taskCount: 200, shuffleReadBytes: 300 * MiB, completedAt: 20 * 60_000 }),
        makeTypedStage({ id: 5, speculationWastedAttempts: 10, speculationWasteMs: 120_000 }),
        makeTypedStage({ id: 6, localityStats: [{ locality: 'PROCESS_LOCAL', count: 50 }, { locality: 'ANY', count: 50 }] }),
      ]),
      ...auditConfig({ config: {}, resources: /** @type {AppResources} */ ({ executor: { memoryMB: 10240, memoryOverheadMB: 256 }, driver: {}, dynamicAllocationEnabled: true, shuffleServiceEnabled: false, serializer: null }) }, new Map([[1, makeTypedStage()]])),
    ];
    expect(findings.some((f) => f.type === 'coreLocality')).toBe(true);
    let checked = 0;
    for (const f of findings) {
      const named = new Set((f.recommendation ?? '').match(/spark\.[A-Za-z.]*[A-Za-z]/g) ?? []);
      const emitted = new Set((f.remediation ?? []).map(remedyKey));
      for (const key of named) {
        checked += 1;
        expect(emitted.has(key), `${f.type}: ${key}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('emits only well-formed entries', () => {
    const findings = [
      ...catalogOf([
        makeTypedStage({ id: 1, sqlExecutionId: 1, shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0, gcPct: 40, jvmGCTime: 4000, memoryBytesSpilled: 3000 * MiB }),
        makeTypedStage({ id: 2, taskCount: 200, taskDurationP50: 80, taskDurationP95: 150, shuffleReadBytes: 10 * MiB }),
        makeTypedStage({ id: 3, taskDurationP50: 100, taskDurationP95: 900, taskDurationMax: 2000 }),
        makeTypedStage({ id: 4, sqlExecutionId: 1, shuffleReadBytes: 300 * MiB }),
      ]),
      ...auditConfig({ config: {}, resources: /** @type {AppResources} */ ({ executor: {}, driver: {}, dynamicAllocationEnabled: true, shuffleServiceEnabled: false, serializer: null }) }),
    ];
    const withRemediation = findings.filter((f) => f.remediation?.length);
    expect(withRemediation.length).toBeGreaterThan(3);
    for (const f of withRemediation) {
      for (const r of f.remediation ?? []) {
        expect(r.kind).toBe('conf');
        if (r.kind !== 'conf') continue;
        expect(['increase', 'decrease', 'set']).toContain(r.direction);
        expect(['number', 'string', 'boolean', 'object']).toContain(typeof r.suggested); // object: null
        expect(r.key, f.type).toMatch(/^spark\./);
      }
    }
  });

  it('reports remediation on every evidence-report row, empty when none applies', () => {
    /** @type {AppModel} */
    const fx = {
      app: makeApp({ config: { 'spark.sql.shuffle.partitions': '2', 'spark.sql.adaptive.enabled': 'false' } }),
      stages: new Map([
        [1, makeTypedStage({ id: 1, shuffleReadBytes: 300 * MiB, taskCount: 2 })],
        [2, makeTypedStage({ id: 2, taskDurationP50: 100, taskDurationP95: 600 })],
      ]),
      executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null,
    };
    const { json } = buildEvidenceReport(fx);
    for (const row of json.findings) expect(Array.isArray(row.remediation), row.type).toBe(true);
    expect(remedyKey(present(json.findings.find((r) => r.type === 'shuffle')).remediation[0])).toBe('spark.sql.shuffle.partitions');
  });

  describe('dynamic allocation remediation follows the effective conf', () => {
    const lowUtil = (/** @type {App} */ app) => {
      const stages = new Map([[1, makeTypedStage({ id: 1 })]]);
      const added = [addedExecutor('1', 0, 4)];
      return analyzedRunFrom({ app, stages, executors: { added: added, removed: [] }, runAggregates: { busyCoreMs: 100 } }).catalog;
    };
    const key = (/** @type {Finding} */ f) => (f.remediation ?? []).map((r) => (r.kind === 'conf' ? `${r.direction} ${r.key}` : r.kind));
    const idleCores = (/** @type {App} */ app) => present(lowUtil(app).find((f) => f.type === 'memoryUtilization' && f.variant === 'idleCores'));
    const utilization = (/** @type {App} */ app) => present(lowUtil(app).find(ofType('utilization')));
    const enable = { kind: 'conf', key: 'spark.dynamicAllocation.enabled', direction: 'set', suggested: true };
    const lowerInstances = { kind: 'conf', key: 'spark.executor.instances', direction: 'decrease', suggested: null };
    const lowerMax = { kind: 'conf', key: 'spark.dynamicAllocation.maxExecutors', direction: 'decrease', suggested: null };

    it('suggests enabling it and a smaller fixed cluster when the run has it off or unset', () => {
      const off = makeApp({ config: { 'spark.dynamicAllocation.enabled': 'false' }, resources: { dynamicAllocationEnabled: false } });
      for (const app of [off, makeApp()]) {
        expect(utilization(app).remediation).toEqual([enable, lowerInstances]);
        expect(idleCores(app).remediation).toEqual([enable, lowerInstances]);
      }
    });

    it('suggests a lower executor cap when the run already has it on', () => {
      const viaResources = makeApp({ resources: { dynamicAllocationEnabled: true } });
      const viaConfig = makeApp({ config: { 'spark.dynamicAllocation.enabled': 'true' } });
      for (const app of [viaResources, viaConfig]) {
        expect(utilization(app).remediation).toEqual([lowerMax]);
        expect(idleCores(app).remediation).toEqual([lowerMax]);
      }
    });

    it('also lowers the executor floor when the logged minExecutors holds one', () => {
      const lowerMin = { kind: 'conf', key: 'spark.dynamicAllocation.minExecutors', direction: 'decrease', suggested: null };
      const on = (/** @type {string | null} */ min) => makeApp({ config: { 'spark.dynamicAllocation.enabled': 'true', ...(min == null ? {} : { 'spark.dynamicAllocation.minExecutors': min }) } });
      for (const f of [utilization(on('4')), idleCores(on('4'))]) {
        expect(f.remediation, f.type).toEqual([lowerMax, lowerMin]);
        expect(f.recommendation, f.type).toMatch(/lowering spark\.dynamicAllocation\.maxExecutors and spark\.dynamicAllocation\.minExecutors/);
      }
      // A floor of 0 or an unlogged one has nothing to lower.
      for (const min of ['0', null]) {
        for (const f of [utilization(on(min)), idleCores(on(min))]) {
          expect(f.remediation, `${f.type} ${min}`).toEqual([lowerMax]);
          expect(f.recommendation, f.type).not.toMatch(/minExecutors/);
        }
      }
      // With dynamic allocation off the floor does not apply.
      const off = makeApp({ config: { 'spark.dynamicAllocation.enabled': 'false', 'spark.dynamicAllocation.minExecutors': '4' } });
      expect(key(utilization(off)).join()).not.toContain('minExecutors');
      expect(coreFindingGenericRecommendation(utilization(on('4'))))
        .toBe('Dynamic allocation is already on, so consider reducing cluster size by lowering spark.dynamicAllocation.maxExecutors and spark.dynamicAllocation.minExecutors.');
      expect(coreFindingGenericRecommendation(idleCores(on('4'))))
        .toBe('Dynamic allocation is already on, so reduce cluster size by lowering spark.dynamicAllocation.maxExecutors and spark.dynamicAllocation.minExecutors.');
    });

    it('words the entries as alternatives when dynamic allocation is off, so one is applied', () => {
      for (const app of [makeApp(), makeApp({ config: { 'spark.dynamicAllocation.enabled': 'false' } })]) {
        expect(utilization(app).recommendation).toMatch(/consider either reducing cluster size \(spark\.executor\.instances\) or enabling dynamic allocation/);
        expect(idleCores(app).recommendation).toMatch(/either reduce cluster size \(spark\.executor\.instances\) or enable dynamic allocation/);
        expect(coreFindingGenericRecommendation(utilization(app)))
          .toBe('Consider either reducing cluster size (spark.executor.instances) or enabling dynamic allocation.');
        expect(coreFindingGenericRecommendation(idleCores(app)))
          .toBe('Either reduce cluster size (spark.executor.instances) or enable dynamic allocation.');
      }
    });

    it('never suggests lowering the idle timeout, which autoscalingChurn raises', () => {
      for (const app of [makeApp(), makeApp({ config: { 'spark.dynamicAllocation.enabled': 'true' } })]) {
        for (const f of [utilization(app), idleCores(app)]) {
          expect(key(f).join(), f.type).not.toContain('executorIdleTimeout');
        }
      }
    });

    it('stops recommending dynamic allocation once it is on, and points at cluster size', () => {
      for (const app of [makeApp({ resources: { dynamicAllocationEnabled: true } }), makeApp({ config: { 'spark.dynamicAllocation.enabled': 'true' } })]) {
        for (const f of [utilization(app), idleCores(app)]) {
          expect(f.recommendation, f.type).not.toMatch(/enabl(e|ing) dynamic allocation/);
          expect(f.recommendation, f.type).toMatch(/dynamic allocation is already on, so .*reduc(e|ing) cluster size by lowering spark\.dynamicAllocation\.maxExecutors/);
        }
      }
      expect(utilization(makeApp()).recommendation).toMatch(/enabling dynamic allocation/);
      expect(idleCores(makeApp()).recommendation).toMatch(/enable dynamic allocation/);
    });

    it('words the grouped generic line for the logged conf the same way as the row', () => {
      for (const app of [makeApp({ resources: { dynamicAllocationEnabled: true } }), makeApp({ config: { 'spark.dynamicAllocation.enabled': 'true' } })]) {
        expect(coreFindingGenericRecommendation(utilization(app)))
          .toBe('Dynamic allocation is already on, so consider reducing cluster size by lowering spark.dynamicAllocation.maxExecutors.');
        expect(coreFindingGenericRecommendation(idleCores(app)))
          .toBe('Dynamic allocation is already on, so reduce cluster size by lowering spark.dynamicAllocation.maxExecutors.');
      }
      expect(coreFindingGenericRecommendation(utilization(makeApp()))).toMatch(/enabling dynamic allocation/);
      expect(coreFindingGenericRecommendation(idleCores(makeApp()))).toMatch(/enable dynamic allocation/);
    });
  });

  describe('a set-to-value remediation follows the logged conf', () => {
    const skewStage = makeTypedStage({ id: 1, taskDurationP50: 100, taskDurationP95: 600, tailAttribution: dataTail(), sqlExecutionId: 7, shuffleReadBytes: 400 * MiB });
    const partitionSkewStage = makeTypedStage({ id: 2, shuffleReadP50: 10 * MiB, shuffleReadMax: 300 * MiB, shuffleReadBytes: 400 * MiB, taskCount: 50, sqlExecutionId: 7 });
    const slowHostStage = makeTypedStage({
      id: 3, taskCount: 60,
      hostStats: [
        { host: 'a', taskCount: 20, totalDuration: 200000 },
        { host: 'b', taskCount: 20, totalDuration: 200000 },
        { host: 'c', taskCount: 20, totalDuration: 600000 },
      ],
    });
    // An unknown Spark version models no defaults, so only the logged conf decides.
    const pick = (/** @type {Config} */ config, /** @type {string | null} */ sparkVersion = null) => {
      const on = (/** @type {Stage} */ stage) => catalogOf([stage], makeApp({ config, sparkVersion }), JOIN_SQL);
      return {
        skew: present(on(skewStage).find(ofType('skew'))),
        partitionSkew: present(on(partitionSkewStage).find(ofRule('shufflePartitionSkew'))),
        slowHost: present(on(slowHostStage).find(ofType('slowHost'))),
      };
    };
    /** @param {string} key @returns {Remediation[]} */
    const set = (key) => [{ kind: 'conf', key, direction: 'set', suggested: true }];

    it('suggests the switch when the run has it off or unset', () => {
      for (const config of /** @type {Config[]} */ ([{}, { 'spark.sql.adaptive.skewJoin.enabled': 'false', 'spark.speculation': 'false' }])) {
        const { skew, partitionSkew, slowHost } = pick(config);
        expect(skew.remediation).toEqual(set('spark.sql.adaptive.skewJoin.enabled'));
        expect(partitionSkew.remediation).toEqual(set('spark.sql.adaptive.skewJoin.enabled'));
        expect(slowHost.remediation).toEqual(set('spark.speculation'));
      }
    });

    it('suggests nothing when the logged conf already has it, compared case-insensitively', () => {
      const { skew, partitionSkew, slowHost } = pick({ 'spark.sql.adaptive.skewJoin.enabled': 'TRUE', 'spark.speculation': 'True' });
      expect(skew.remediation).toEqual(SKEW_CODE_FIX);
      expect(partitionSkew.remediation).toEqual(SKEW_CODE_FIX);
      expect(slowHost.remediation).toEqual([]);
    });

    it('stops recommending a switch the logged conf already has on, and names the remedy left', () => {
      const { skew, partitionSkew, slowHost } = pick({ 'spark.sql.adaptive.skewJoin.enabled': 'true', 'spark.speculation': 'true' });
      for (const f of [skew, partitionSkew]) {
        expect(f.recommendation, f.type).not.toMatch(/spark\.sql\.adaptive\.skewJoin\.enabled|enable AQE/);
        expect(f.recommendation, f.type).toMatch(/already on, so salt the key or repartition on a better key/);
      }
      expect(slowHost.recommendation).not.toMatch(/spark\.speculation|consider enabling/);
      expect(slowHost.recommendation).toMatch(/speculation is already on/);
      expect(recommendationParts(present(slowHost.recommendation)).fix)
        .toBe('check what it was running; speculation is already on, so a lagging task there is already relaunched.');
      expect(recommendationParts(present(pick({}).slowHost.recommendation)).fix)
        .toBe('check what it was running, and consider enabling spark.speculation to relaunch a lagging task automatically.');
      const unset = pick({});
      expect(unset.skew.recommendation).toMatch(/enable AQE skew-join handling \(spark\.sql\.adaptive\.skewJoin\.enabled\)/);
      expect(unset.partitionSkew.recommendation).toMatch(/enable AQE skew-join handling \(spark\.sql\.adaptive\.skewJoin\.enabled\)/);
      expect(unset.slowHost.recommendation).toMatch(/consider enabling spark\.speculation/);
    });

    it('treats the Spark version default as the effective value when the key is not logged', () => {
      /** @type {Remediation[]} */
      const aqe = [{ kind: 'conf', key: 'spark.sql.adaptive.enabled', direction: 'set', suggested: true }];
      // 3.2+: AQE and skew-join handling both default on, so there is nothing to suggest.
      for (const version of ['3.2.0', '3.5.3', '4.0.0']) {
        const { skew, partitionSkew } = pick({}, version);
        for (const f of [skew, partitionSkew]) {
          expect(f.remediation, `${f.type} ${version}`).toEqual(SKEW_CODE_FIX);
          expect(f.recommendation).toMatch(/already on/);
        }
      }
      // 3.0 and 3.1: AQE defaults off, skew-join handling on once AQE is.
      for (const version of ['3.0.3', '3.1.2']) {
        expect(pick({}, version).skew.remediation, version).toEqual(aqe);
      }
      // A logged value beats the default.
      expect(pick({ 'spark.sql.adaptive.skewJoin.enabled': 'false' }, '3.5.3').skew.remediation).toEqual(set('spark.sql.adaptive.skewJoin.enabled'));
      expect(pick({ 'spark.sql.adaptive.enabled': 'false' }, '3.5.3').skew.remediation).toEqual(aqe);
    });

    it('words the grouped generic line for a switch the logged conf already has on, as the row does', () => {
      const on = pick({ 'spark.sql.adaptive.skewJoin.enabled': 'TRUE', 'spark.speculation': 'true' });
      for (const f of [on.skew, on.partitionSkew]) {
        expect(coreFindingGenericRecommendation(f), f.type).toBe('AQE skew-join handling is already on, so salt the key or repartition on a better key.');
      }
      expect(coreFindingGenericRecommendation(on.slowHost)).not.toMatch(/spark\.speculation/);
      expect(coreFindingGenericRecommendation(on.slowHost)).toMatch(/Speculation is already on, so a lagging task there is already relaunched\.$/);
      const unset = pick({});
      for (const f of [unset.skew, unset.partitionSkew]) {
        expect(coreFindingGenericRecommendation(f), f.type).toMatch(/enable AQE skew-join handling \(spark\.sql\.adaptive\.skewJoin\.enabled\)/);
      }
      expect(coreFindingGenericRecommendation(unset.slowHost)).toMatch(/Enable spark\.speculation/);
    });

    it('counts skew-join as on only while AQE is not logged off, and suggests enabling AQE otherwise', () => {
      /** @type {Remediation[]} */
      const aqe = [{ kind: 'conf', key: 'spark.sql.adaptive.enabled', direction: 'set', suggested: true }];
      const skewJoin = set('spark.sql.adaptive.skewJoin.enabled');
      for (const [config, remediation] of /** @type {[Config, Remediation[]][]} */ ([
        [{ 'spark.sql.adaptive.enabled': 'false', 'spark.sql.adaptive.skewJoin.enabled': 'true' }, aqe],
        [{ 'spark.sql.adaptive.enabled': 'false' }, [...aqe, ...skewJoin]],
      ])) {
        const { skew, partitionSkew } = pick(config);
        for (const f of [skew, partitionSkew]) {
          expect(f.remediation, f.type).toEqual(remediation);
          expect(f.recommendation, f.type).toMatch(/AQE is off, so enable it \(spark\.sql\.adaptive\.enabled\)/);
          expect(recommendationParts(present(f.recommendation)).fix, f.type).toMatch(/^AQE is off/);
          expect(coreFindingGenericRecommendation(f), f.type).toMatch(/^AQE is off, so enable it \(spark\.sql\.adaptive\.enabled\)/);
        }
      }
      const { skew } = pick({ 'spark.sql.adaptive.enabled': 'true', 'spark.sql.adaptive.skewJoin.enabled': 'true' });
      expect(skew.remediation).toEqual(SKEW_CODE_FIX);
      expect(coreFindingGenericRecommendation(skew)).toMatch(/already on/);
    });

    it('words the grouped lowShuffleParallelism line as the row does when the logged count is already enough', () => {
      const row = (/** @type {Config} */ config) => present(catalogOf(
        [makeTypedStage({ shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0 })],
        makeApp({ config: { 'spark.sql.adaptive.enabled': 'false', ...config } }),
      ).find(ofRule('lowShuffleParallelism')));
      const enough = coreFindingGenericRecommendation(row({ 'spark.sql.shuffle.partitions': '200' }));
      expect(enough).toMatch(/repartition\(n\)/);
      expect(enough).not.toMatch(/^Raise spark\.sql\.shuffle\.partitions/);
      expect(coreFindingGenericRecommendation(row({ 'spark.sql.shuffle.partitions': '8' }))).toBe('Raise spark.sql.shuffle.partitions so each partition is smaller.');
    });

    it('suggests no broadcast threshold change, and points at the hint, when auto-broadcast is logged disabled', () => {
      /** @type {PlanNode} */
      const tree = { name: 'BroadcastHashJoin', detail: '', metrics: [], children: [
        { name: 'BroadcastExchange', detail: '', id: '2', metrics: [{ name: 'data size', value: 2 * 1024 * MiB, metricType: 'size' }], children: [] },
      ] };
      const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree: tree }]]);
      const over = (/** @type {Config} */ config) => present(analyzedRunFrom({ app: makeApp({ config }), sql }).catalog.find(ofType('overBroadcast')));
      const off = over({ 'spark.sql.autoBroadcastJoinThreshold': '-1' });
      expect(off.remediation).toEqual([]);
      expect(off.recommendation).toMatch(/remove the broadcast\(\) hint/);
      expect(coreFindingGenericRecommendation(off)).toMatch(/remove the broadcast\(\) hint/);
      // Only a threshold above the broadcast could have admitted it, so only then is lowering it advice.
      for (const config of /** @type {Config[]} */ ([{ 'spark.sql.autoBroadcastJoinThreshold': '4g' }, { 'spark.sql.autoBroadcastJoinThreshold': '4294967296' }])) {
        const f = over(config);
        expect(f.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.autoBroadcastJoinThreshold', direction: 'decrease', suggested: null }]);
        expect(coreFindingGenericRecommendation(f)).toMatch(/misconfigured spark\.sql\.autoBroadcastJoinThreshold/);
      }
    });

    it('words the missing-evidence caveats for a logging switch that is already on', () => {
      const rdd = (/** @type {number} */ id) => ({
        id, name: `rdd${id}`, storageLevel: { useMemory: true, useDisk: false, deserialized: true, replication: 1 },
        numPartitions: 10, numCachedPartitions: 0, memorySize: 0, diskSize: 0,
      });
      const caveats = (/** @type {Config} */ config) => {
        const app = makeApp({ config, rddInfo: new Map([[1, rdd(1)]]), rddBlockUpdates: 0 });
        const findings = analyzedRunFrom({ app, stages: new Map([[1, makeTypedStage({ id: 1 })]]), executors: { added: [addedExecutor('1', 0, 4)], removed: [] } }).catalog;
        return {
          storage: findings.find((f) => f.type === 'cacheUtilization' && f.variant === 'storageUnobserved'),
          memory: present(findings.find((f) => f.type === 'memoryUtilization' && f.variant === 'memoryBand')),
        };
      };
      const off = caveats({});
      expect(present(off.storage).recommendation).toMatch(/need spark\.eventLog\.logBlockUpdates\.enabled=true/);
      expect(present(off.storage).remediation).toEqual(set('spark.eventLog.logBlockUpdates.enabled'));
      expect(off.memory.recommendation).toMatch(/Executor heap peaks are missing from this log/);
      expect(off.memory.remediation).toEqual(set('spark.eventLog.logStageExecutorMetrics'));
      const on = caveats({ 'spark.eventLog.logBlockUpdates.enabled': 'true', 'spark.eventLog.logStageExecutorMetrics': 'true' });
      expect(on.storage).toBeUndefined();
      expect(on.memory.remediation).toEqual([]);
      expect(off.memory.recommendation).toMatch(/was not measured\. To measure it, set spark\.eventLog\.logStageExecutorMetrics=true/);
      expect(on.memory.recommendation).toMatch(/was not measured\. spark\.eventLog\.logStageExecutorMetrics is already on, so no executor ran long enough/);
      expect(on.memory.recommendation).not.toMatch(/To measure it/);
    });

    it('suggests Kryo unless the logged serializer is already Kryo', () => {
      const res = /** @type {AppResources} */ ({ executor: {}, driver: {}, dynamicAllocationEnabled: false, shuffleServiceEnabled: true, serializer: null });
      const rddStages = new Map([[1, makeTypedStage()]]);
      const java = present(auditConfig({ config: { 'spark.app.name': 'x' }, resources: res }, rddStages).find(ofProperty('spark.serializer')));
      expect(java.remediation).toEqual([{ kind: 'conf', key: 'spark.serializer', direction: 'set', suggested: KRYO }]);
      const kryo = auditConfig({ config: { 'spark.serializer': KRYO }, resources: res }, rddStages).find(ofProperty('spark.serializer'));
      expect(kryo).toBeUndefined();
    });
  });
});

describe('skew remediation follows what the stage reads', () => {
  const app = makeApp({ sparkVersion: '3.1.2', config: {} });
  /** @type {SqlMap} */
  const AGG_SQL = new Map([[8, { id: 8, planTree: { name: 'HashAggregate', detail: '', metrics: [], children: [] } }]]);
  const skewOf = (/** @type {Stage} */ stage, /** @type {SqlMap} */ sql) => present(catalogOf([stage], app, sql).find(ofType('skew')));
  const skewed = { taskDurationP50: 100, taskDurationP95: 600, tailAttribution: dataTail() };

  it('flags a shuffle read feeding a join as shuffleJoin and suggests skew-join handling', () => {
    const f = skewOf(makeTypedStage({ ...skewed, sqlExecutionId: 7, shuffleReadBytes: 400 * MiB }), JOIN_SQL);
    expect(f.origin).toBe('shuffleJoin');
    expect(present(f.remediation).map(remedyKey)).toEqual(['spark.sql.adaptive.enabled']);
    expect(f.recommendation).toMatch(/skew-join/);
  });

  it('points a scan with uneven input at file sizes, not at skew-join handling', () => {
    const f = skewOf(makeTypedStage({ ...skewed, sqlExecutionId: 7, inputBytes: 220 * MiB }), JOIN_SQL);
    expect(f.origin).toBe('inputScan');
    expect(f.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.files.maxPartitionBytes', direction: 'decrease', suggested: null }]);
    expect(f.recommendation).toMatch(/compact small files.*maxPartitionBytes/);
    expect(f.recommendation).not.toMatch(/skewJoin|AQE/);
    expect(coreFindingGenericRecommendation(f)).toMatch(/compact small files/);
  });

  it('suggests no conf for a shuffle that feeds no join, or for a stage the plan cannot tie to one', () => {
    for (const [stage, sql] of /** @type {[Stage, SqlMap][]} */ ([
      [makeTypedStage({ ...skewed, sqlExecutionId: 8, shuffleReadBytes: 400 * MiB }), AGG_SQL],
      [makeTypedStage({ ...skewed, shuffleReadBytes: 400 * MiB }), new Map()],
      [makeTypedStage({ ...skewed }), new Map()],
    ])) {
      const f = skewOf(stage, sql);
      expect(f.origin).toBe('other');
      expect(f.remediation).toEqual(SKEW_CODE_FIX);
      expect(f.recommendation).not.toMatch(/skewJoin|AQE/);
      expect(coreFindingGenericRecommendation(f)).toMatch(/salt the key/);
    }
  });

  it('gates the partition-skew rule the same way and publishes the origin as evidence', () => {
    const stage = { shuffleReadP50: 10 * MiB, shuffleReadMax: 300 * MiB, shuffleReadBytes: 400 * MiB, taskCount: 50 };
    const join = present(catalogOf([makeTypedStage({ ...stage, sqlExecutionId: 7 })], app, JOIN_SQL).find(ofRule('shufflePartitionSkew')));
    const agg = present(catalogOf([makeTypedStage({ ...stage, sqlExecutionId: 8 })], app, AGG_SQL).find(ofRule('shufflePartitionSkew')));
    expect(join.origin).toBe('shuffleJoin');
    expect(present(join.remediation).length).toBeGreaterThan(0);
    expect(agg.origin).toBe('other');
    expect(agg.remediation).toEqual(SKEW_CODE_FIX);
    /** @type {AppModel} */
    const fx = {
      app, stages: new Map([[1, makeTypedStage({ ...stage, sqlExecutionId: 8 })]]),
      executors: { added: [], removed: [] }, sql: AGG_SQL, jobs: new Map(), runAggregates: null, evidenceAvailability: null,
    };
    const { json } = buildEvidenceReport(fx);
    const skewRow = present(json.findings.flatMap((r) => (r.type === 'partitionSizing' ? [r] : [])).find((r) => r.evidence.rule === 'shufflePartitionSkew'));
    expect(skewRow.evidence.origin).toBe('other');
  });
});

describe('partition-skew rule on a stage whose input exceeds its shuffle read', () => {
  it('keeps a shuffle-based origin, never the input-file remedy', () => {
    const app = makeApp();
    const stage = makeTypedStage({
      shuffleReadP50: 10 * MiB, shuffleReadMax: 300 * MiB, shuffleReadBytes: 400 * MiB,
      inputBytes: 2000 * MiB, taskCount: 50, sqlExecutionId: 7,
    });
    const f = present(catalogOf([stage], app, JOIN_SQL).find(ofRule('shufflePartitionSkew')));
    expect(f.origin).toBe('shuffleJoin');
    expect(f.recommendation).not.toMatch(/maxPartitionBytes/);
    expect(present(f.remediation).map(remedyKey)).not.toContain('spark.sql.files.maxPartitionBytes');
  });
});

describe('findings for stages that read no shuffle or that have an even host count', () => {
  const app = makeApp();

  it('does not suggest shuffle partitions for a slow stage that reads no shuffle', () => {
    const slow = (/** @type {Partial<Stage>} */ extra) => present(catalogOf([makeTypedStage({ submittedAt: 0, completedAt: 20 * 60000, ...extra })], app).find(ofType('stageSlowness')));
    const shuffle = slow({ taskCount: 200, shuffleReadBytes: 10 * MiB });
    expect(shuffle.reads).toBe('shuffle');
    expect(present(shuffle.remediation).map(remedyKey)).toEqual(['spark.sql.shuffle.partitions']);
    expect(shuffle.recommendation).not.toMatch(/default\.parallelism/);
    const scan = slow({ inputBytes: 10 * MiB });
    expect(scan.reads).toBe('input');
    expect(scan.remediation).toEqual([{ kind: 'conf', key: 'spark.sql.files.maxPartitionBytes', direction: 'decrease', suggested: null }]);
    expect(scan.recommendation).not.toMatch(/shuffle\.partitions/);
    expect(coreFindingGenericRecommendation(scan)).toMatch(/maxPartitionBytes/);
    const neither = slow({});
    expect(neither.reads).toBe('other');
    expect(neither.remediation).toEqual([]);
  });

  it('measures a slow host against the textbook median of the host means', () => {
    // Means 1000, 1000, 1900, 3700 ms: the median is 1450 (not the upper middle, 1900), so the
    // slowest host runs 2.55x it and is flagged; against 1900 it would be 1.95x and pass.
    const hostStats = [1000, 1000, 1900, 3700].map((mean, i) => ({ host: `h${i}`, taskCount: 10, totalDuration: mean * 10 }));
    const found = catalogOf([makeTypedStage({ taskCount: 40, hostStats })], app).filter(ofType('slowHost'));
    expect(found.map((f) => ('host' in f ? f.host : undefined))).toEqual(['h3']);
    expect(found[0].value).toBe(2.6);
  });
});

describe('remediation fits the stage, plan and effective conf across finding types', () => {
  const GiB = 1024 * MiB;
  const keys = (/** @type {Finding} */ f) => present(f.remediation).map(remedyKey);
  /**
   * @template {Finding['type']} T
   * @param {T} type
   * @param {Stage[]} stages
   * @param {App} app
   * @param {SqlMap} [sql]
   */
  const of = (type, stages, app, sql = new Map()) => present(catalogOf(stages, app, sql).find(/** @returns {f is Extract<Finding, { type: T }>} */ (f) => f.type === type));
  const key = (/** @type {string} */ name, /** @type {string} */ direction) => ({ kind: 'conf', key: name, direction, suggested: null });

  describe('spill', () => {
    /** @type {Partial<Stage>} */
    const spilled = { memoryBytesSpilled: 5 * GiB, spillClassification: 'unclassified' };
    it('drops the shuffle-partition advice for a stage that reads no shuffle, and says why in evidence', () => {
      const scan = of('spill', [makeTypedStage({ ...spilled, inputBytes: 10 * GiB })], makeApp());
      expect(scan.reads).toBe('input');
      expect(keys(scan)).toEqual(['spark.executor.memory']);
      expect(scan.recommendation).not.toMatch(/shuffle\.partitions/);
      expect(coreFindingGenericRecommendation(scan)).not.toMatch(/shuffle\.partitions/);
    });
    it('keeps it for a stage that reads a shuffle', () => {
      const f = of('spill', [makeTypedStage({ ...spilled, taskCount: 200, shuffleReadBytes: 10 * GiB })], makeApp());
      expect(f.reads).toBe('shuffle');
      expect(keys(f)).toEqual(['spark.sql.shuffle.partitions', 'spark.executor.memory']);
    });
  });

  describe('shuffle', () => {
    const app = (/** @type {Config} */ config, /** @type {string | null} */ sparkVersion = null) => makeApp({ config, sparkVersion });
    it('does not suggest more partitions when the tasks are already a good size', () => {
      // 200 MiB over 5000 tasks with a logged count of 5000.
      const f = of('shuffle', [makeTypedStage({ shuffleReadBytes: 200 * MiB, taskCount: 5000 })], app({ 'spark.sql.shuffle.partitions': '5000' }));
      expect(f.partitions).toBe('sufficient');
      expect(f.remediation).toEqual([]);
      expect(f.recommendation).toMatch(/broadcast join/);
      expect(f.recommendation).not.toMatch(/increasing spark\.sql\.shuffle\.partitions/);
    });
    it('points at the advisory partition size when AQE coalesced a shuffle that is still large', () => {
      const f = of('shuffle', [makeTypedStage({ shuffleReadBytes: 600 * MiB, taskCount: 2, sqlExecutionId: 1 })], app({}, '3.5.3'));
      expect(f.partitions).toBe('aqeCoalesced');
      expect(f.remediation).toEqual([key('spark.sql.adaptive.advisoryPartitionSizeInBytes', 'decrease')]);
    });
    it('points at the stage\'s own partitioning when the property already gives the count needed', () => {
      const f = of('shuffle', [makeTypedStage({ shuffleReadBytes: 600 * MiB, taskCount: 2 })], app({ 'spark.sql.adaptive.enabled': 'false' }));
      expect(f.partitions).toBe('ownPartitioning');
      expect(f.remediation).toEqual([]);
      expect(f.recommendation).toMatch(/repartition\(n\)/);
    });
    it('suggests more partitions when the property is what limits the stage', () => {
      const f = of('shuffle', [makeTypedStage({ shuffleReadBytes: 600 * MiB, taskCount: 2 })], app({ 'spark.sql.shuffle.partitions': '2', 'spark.sql.adaptive.enabled': 'false' }));
      expect(f.partitions).toBe('raise');
      expect(f.remediation).toEqual([key('spark.sql.shuffle.partitions', 'increase')]);
    });
  });

  describe('autoscalingChurn and coldStart follow dynamic allocation', () => {
    const added = Array.from({ length: 10 }, (_, i) => addedExecutor(String(i + 1), 0, 1));
    const removed = added.map((e) => removedExecutor(e.executorId, 60_000));
    const churn = (/** @type {Config} */ config) => present(analyzedRunFrom({ app: makeApp({ startTime: 0, endTime: 600_000, config }), executors: { added: added, removed: removed } }).catalog
      .find(ofType('autoscalingChurn')));
    it('gives no dynamic-allocation advice when the run turns it off', () => {
      const off = churn({ 'spark.dynamicAllocation.enabled': 'false' });
      expect(off.dynamicAllocation).toBe('off');
      expect(off.remediation).toEqual([]);
      expect(off.recommendation).not.toMatch(/spark\.dynamicAllocation/);
      expect(coreFindingGenericRecommendation(off)).not.toMatch(/spark\.dynamicAllocation/);
      const on = churn({ 'spark.dynamicAllocation.enabled': 'true' });
      expect(on.dynamicAllocation).toBe('on');
      expect(on.remediation).toHaveLength(3);
    });
    it('records on coldStart which case fired', () => {
      const cold = (/** @type {Config} */ config) => present(analyzedRunFrom({ app: makeApp({ config }), stages: new Map([[1, makeTypedStage({ id: 1, submittedAt: 60_000, completedAt: 70_000 })]]), executors: { added: [addedExecutor('1', 120_000, 4)], removed: [] } }).catalog.find(ofType('coldStart')));
      expect(cold({ 'spark.dynamicAllocation.enabled': 'false' }).dynamicAllocation).toBe('off');
      expect(cold({ 'spark.dynamicAllocation.enabled': 'false' }).remediation).toEqual([]);
      expect(cold({ 'spark.dynamicAllocation.enabled': 'true' }).dynamicAllocation).toBe('on');
    });
  });

  describe('straggler prose follows the stage', () => {
    // A P95 at the median keeps skew's duration gate shut, so the data-driven tail is straggler's.
    const straggler = { taskCount: 100, stragglerCount: 20, taskDurationP50: 100, taskDurationP95: 100, taskDurationMax: 5000, tailAttribution: dataTail() };
    const app = makeApp({ sparkVersion: '3.5.3' });
    it('names no AQE skew-join sentence for a scan stage, and no conf for an unrelated one', () => {
      const scan = of('straggler', [makeTypedStage({ ...straggler, inputBytes: 10 * GiB })], app);
      expect(scan.origin).toBe('inputScan');
      expect(scan.recommendation).not.toMatch(/AQE|skewJoin/);
      expect(keys(scan)).toEqual(['spark.sql.files.maxPartitionBytes']);
      expect(coreFindingGenericRecommendation(scan)).not.toMatch(/AQE|skewJoin/);
      const other = of('straggler', [makeTypedStage({ ...straggler })], app);
      expect(other.origin).toBe('other');
      expect(other.remediation).toEqual(SKEW_CODE_FIX);
    });
    it('says skew-join handling is already on for a join stage on Spark 3.5, and suggests it where it is off', () => {
      const stage = makeTypedStage({ ...straggler, sqlExecutionId: 7, shuffleReadBytes: 400 * MiB });
      const on = of('straggler', [stage], app, JOIN_SQL);
      expect(on.origin).toBe('shuffleJoin');
      expect(on.remediation).toEqual(SKEW_CODE_FIX);
      expect(on.recommendation).toMatch(/already on/);
      const off = of('straggler', [stage], makeApp({ sparkVersion: '3.5.3', config: { 'spark.sql.adaptive.skewJoin.enabled': 'false' } }), JOIN_SQL);
      expect(keys(off)).toEqual(['spark.sql.adaptive.skewJoin.enabled']);
    });
  });

  describe('broadcast thresholds', () => {
    const exchange = (/** @type {number} */ bytes) => /** @type {PlanNode} */ ({ name: 'Exchange', detail: '', id: 'x', metrics: [{ name: 'data size', value: bytes, metricType: 'size' }], children: [] });
    /** @param {number} small @param {number} large @returns {SqlMap} */
    const joinPlan = (small, large) => new Map([[1, { id: 1, planTree: { name: 'SortMergeJoin', detail: 'SortMergeJoin [a#1L], [b#2L], Inner', metrics: [], children: [exchange(small), exchange(large)] } }]]);
    /** @param {number} bytes @returns {SqlMap} */
    const broadcastPlan = (bytes) => new Map([[1, { id: 1, planTree: { name: 'BroadcastExchange', detail: '', id: 'b', metrics: [{ name: 'data size', value: bytes, metricType: 'size' }], children: [] } }]]);
    /**
     * @template {Finding['type']} T
     * @param {T} type
     * @param {SqlMap} sql
     * @param {Config} config
     */
    const run = (type, sql, config) => present(catalogOf([], makeApp({ config, sparkVersion: null }), sql).find(/** @returns {f is Extract<Finding, { type: T }>} */ (f) => f.type === type));

    it('does not raise a threshold that already admits the smaller side', () => {
      // 5 MiB is under both Spark's 10 MiB default and a logged 1 GiB.
      for (const config of /** @type {Config[]} */ ([{}, { 'spark.sql.autoBroadcastJoinThreshold': '1g' }])) {
        const f = run('underBroadcast', joinPlan(5 * MiB, 20 * GiB), config);
        expect(f.broadcastThreshold).toBe('notLimiting');
        expect(f.remediation).toEqual([]);
        expect(f.recommendation).toMatch(/statistics/);
        expect(coreFindingGenericRecommendation(f)).toMatch(/already admits/);
        expect(coreFindingGenericRecommendation({ ...f, buildSide: 'left' })).toBe(coreFindingGenericRecommendation({ ...f, buildSide: 'right' }));
      }
    });
    it('still raises it when the threshold is below the smaller side or auto-broadcast is disabled', () => {
      const below = run('underBroadcast', joinPlan(5 * MiB, 20 * GiB), { 'spark.sql.autoBroadcastJoinThreshold': '1m' });
      expect(below.broadcastThreshold).toBe('limits');
      expect(keys(below)).toEqual(['spark.sql.autoBroadcastJoinThreshold']);
      const off = run('underBroadcast', joinPlan(5 * MiB, 20 * GiB), { 'spark.sql.autoBroadcastJoinThreshold': '-1' });
      expect(off.broadcastThreshold).toBe('disabled');
      expect(keys(off)).toEqual(['spark.sql.autoBroadcastJoinThreshold']);
    });
    it('does not lower a threshold that is already below the broadcast that fired', () => {
      // A 1.5 GiB broadcast cannot come from the 10 MiB default: a hint forced it.
      for (const config of /** @type {Config[]} */ ([{}, { 'spark.sql.autoBroadcastJoinThreshold': '100m' }])) {
        const f = run('overBroadcast', broadcastPlan(1.5 * GiB), config);
        expect(f.broadcastThreshold).toBe('notLimiting');
        expect(f.remediation).toEqual([]);
        expect(f.recommendation).toMatch(/hint forced it/);
        expect(coreFindingGenericRecommendation(f)).toMatch(/remove the broadcast\(\) hint/);
      }
      const huge = run('overBroadcast', broadcastPlan(1.5 * GiB), { 'spark.sql.autoBroadcastJoinThreshold': '4g' });
      expect(huge.broadcastThreshold).toBe('limits');
      expect(keys(huge)).toEqual(['spark.sql.autoBroadcastJoinThreshold']);
      expect(run('overBroadcast', broadcastPlan(1.5 * GiB), { 'spark.sql.autoBroadcastJoinThreshold': '-1' }).broadcastThreshold).toBe('disabled');
    });
  });

  describe('skew advice on Spark 2.x', () => {
    it('does not suggest AQE, which does not exist before Spark 3.0', () => {
      const f = of('skew', [makeTypedStage({ taskDurationP50: 100, taskDurationP95: 600, tailAttribution: dataTail(), sqlExecutionId: 7, shuffleReadBytes: 400 * MiB })], makeApp({ sparkVersion: '2.4.8' }), JOIN_SQL);
      expect(f.origin).toBe('other');
      expect(f.remediation).toEqual(SKEW_CODE_FIX);
      expect(f.recommendation).not.toMatch(/AQE/);
    });
  });

  describe('tinyTask, speculationWaste and the shuffle remedy', () => {
    const tiny = { taskCount: 200, taskDurationP50: 50, taskDurationP95: 100, taskDurationMax: 100 };
    it('records what a tiny-task stage reads and gives the shuffle remedy only to a shuffle stage', () => {
      const shuffle = of('tinyTask', [makeTypedStage({ ...tiny, shuffleReadBytes: 10 * MiB })], makeApp());
      expect(shuffle.reads).toBe('shuffle');
      expect(keys(shuffle)).toEqual(['spark.sql.shuffle.partitions']);
      const scan = of('tinyTask', [makeTypedStage({ ...tiny, inputBytes: 10 * GiB, shuffleReadBytes: 1024 })], makeApp());
      expect(scan.reads).toBe('input');
      expect(scan.remediation).toEqual([]);
      expect(scan.recommendation).not.toMatch(/shuffle\.partitions/);
      expect(coreFindingGenericRecommendation(scan)).not.toMatch(/shuffle\.partitions/);
    });
  });
});

describe('partition-count advice follows what sized the stage', () => {
  const GiB = 1024 * MiB;
  const ADVISORY = 'spark.sql.adaptive.advisoryPartitionSizeInBytes';
  const PARALLELISM_FIRST = 'spark.sql.adaptive.coalescePartitions.parallelismFirst';
  // A stage in a SQL execution, the only place AQE reshapes a stage's task count.
  // The final plan of the execution: no AQE skew-join split, so a count above the configured one is the stage's own.
  /** @type {SqlMap} */
  const FINAL_PLAN = new Map([[3, { id: 3, planTree: { name: 'AdaptiveSparkPlan', detail: 'isFinalPlan=true', metrics: [], children: [] } }]]);
  // The same plan with a repartition(n) the job wrote: the only plan that makes the stage's own count the cause.
  /** @type {SqlMap} */
  const REPARTITIONED = new Map([[3, { id: 3, planTree: { name: 'AdaptiveSparkPlan', detail: 'isFinalPlan=true', metrics: [], children: [
    { name: 'Exchange', detail: 'Exchange hashpartitioning(k#1L, 64), REPARTITION_BY_NUM, [plan_id=4]', metrics: [], children: [] }] } }]]);
  /**
   * @template {Finding['type']} T
   * @param {T} type
   * @param {Partial<Stage>} stage
   * @param {Config} [config]
   * @param {string} [sparkVersion]
   * @param {SqlMap} [sql]
   */
  const of = (type, stage, config = {}, sparkVersion = '3.5.0', sql = FINAL_PLAN) =>
    present(catalogOf([makeTypedStage({ sqlExecutionId: 3, ...stage })], makeApp({ config, sparkVersion }), sql).find(/** @returns {f is Extract<Finding, { type: T }>} */ (f) => f.type === type));
  const keys = (/** @type {Finding} */ f) => present(f.remediation).map((r) => remedyKey(r) ?? r.kind);
  const tiny = { taskCount: 400, taskDurationP50: 50, taskDurationP95: 100, shuffleReadBytes: 10 * MiB };

  describe('tinyTask', () => {
    it('sends a repartition(n) stage to the code, not to spark.sql.shuffle.partitions', () => {
      const f = of('tinyTask', tiny, { 'spark.sql.shuffle.partitions': '64' }, '3.5.0', REPARTITIONED);
      expect(keys(f)).toEqual(['code']);
      expect(f.recommendation).toMatch(/repartition\(n\)/);
      expect(f.recommendation).not.toMatch(/spark\.sql\.shuffle\.partitions/);
      expect(coreFindingGenericRecommendation(f)).not.toMatch(/spark\.sql\.shuffle\.partitions/);
    });

    it('names the AQE coalescing levers where AQE already merged the shuffle', () => {
      const f = of('tinyTask', { ...tiny, taskCount: 120 }, { 'spark.sql.shuffle.partitions': '400' });
      expect(keys(f)).toEqual([PARALLELISM_FIRST, ADVISORY]);
      expect(present(f.remediation)[0]).toMatchObject({ direction: 'set', suggested: false });
      expect(f.recommendation).toMatch(/parallelismFirst=false/);
      expect(f.recommendation).not.toMatch(/spark\.sql\.shuffle\.partitions/);
      expect(coreFindingGenericRecommendation(f)).toMatch(/parallelismFirst/);
    });

    it('raises the advisory size once parallelismFirst is already off', () => {
      const f = of('tinyTask', { ...tiny, taskCount: 120 }, { 'spark.sql.shuffle.partitions': '400', [PARALLELISM_FIRST]: 'false' });
      expect(f.remediation).toEqual([{ kind: 'conf', key: ADVISORY, direction: 'increase', suggested: null }]);
    });

    it('treats a stage outside any SQL execution as its own partitioning, never as AQE coalescing', () => {
      const f = of('tinyTask', { ...tiny, taskCount: 120, sqlExecutionId: null }, { 'spark.sql.shuffle.partitions': '200' });
      expect(keys(f)).toEqual(['code']);
      expect(f.recommendation).not.toMatch(/AQE|advisoryPartitionSize/);
    });

    it('does not blame repartition(n) for tasks AQE added or for a changed initialPartitionNum', () => {
      const split = of('tinyTask', { ...tiny, taskCount: 212 }, { 'spark.sql.shuffle.partitions': '200' }, '3.5.0', new Map());
      expect(keys(split)).toEqual(['spark.sql.shuffle.partitions']);
      expect(split.recommendation).not.toMatch(/lowering the repartition/);
      expect(split.recommendation).toMatch(/ran 212 tasks against 200 configured/);
      const initial = { 'spark.sql.shuffle.partitions': '200', 'spark.sql.adaptive.coalescePartitions.initialPartitionNum': '1000' };
      /** @type {SqlMap} */
      const skewedPlan = new Map([[3, { id: 3, planTree: { name: 'AdaptiveSparkPlan', detail: 'isFinalPlan=true', metrics: [], children: [
        { name: 'AQEShuffleRead', detail: 'skewed', metrics: [], children: [] }] } }]]);
      expect(keys(of('tinyTask', { ...tiny, taskCount: 212 }, { 'spark.sql.shuffle.partitions': '200' }, '3.5.0', skewedPlan))).toEqual(['spark.sql.shuffle.partitions']);
      // A plan with no repartition behind the difference states the counts neutrally and keeps the property.
      const neutral = of('tinyTask', { ...tiny, taskCount: 212 }, { 'spark.sql.shuffle.partitions': '200' });
      expect(keys(neutral)).toEqual(['spark.sql.shuffle.partitions']);
      expect(neutral.recommendation).toMatch(/ran 212 tasks against 200 configured, and the plan shows no repartition/);
      expect(neutral.recommendation).not.toMatch(/lowering the repartition/);
      // A repartition(n) the job wrote in the plan is the stage's own count.
      expect(keys(of('tinyTask', { ...tiny, taskCount: 212 }, { 'spark.sql.shuffle.partitions': '200' }, '3.5.0', REPARTITIONED))).toEqual(['code']);
      // A repartition(n) next to an AQE skew split: the note names the split and never says the plan has no repartition.
      /** @type {SqlMap} */
      const repartitionedSkew = new Map([[3, { id: 3, planTree: { name: 'AdaptiveSparkPlan', detail: 'isFinalPlan=true', metrics: [], children: [
        { name: 'Exchange', detail: 'Exchange hashpartitioning(k#1L, 300), REPARTITION_BY_NUM, [plan_id=4]', metrics: [], children: [] },
        { name: 'AQEShuffleRead', detail: 'skewed', metrics: [], children: [] }] } }]]);
      const both = of('tinyTask', { ...tiny, taskCount: 212 }, { 'spark.sql.shuffle.partitions': '200' }, '3.5.0', repartitionedSkew);
      expect(keys(both)).toEqual(['spark.sql.shuffle.partitions']);
      expect(both.recommendation).toMatch(/ran 212 tasks against 200 configured, and AQE skew-join splits add tasks/);
      expect(both.recommendation).not.toMatch(/plan shows no repartition/);
      // The note adds no ": ", so the verdict card's split still puts the advice under the fix.
      expect(recommendationParts(present(both.recommendation)).fix).toMatch(/Try lowering spark\.sql\.shuffle\.partitions/);
      expect(recommendationParts(present(neutral.recommendation)).fix).toMatch(/Try lowering spark\.sql\.shuffle\.partitions/);
      const merged = of('tinyTask', { ...tiny, taskCount: 300 }, initial);
      expect(keys(merged)).toEqual([PARALLELISM_FIRST, ADVISORY]);
      const exact = of('tinyTask', { ...tiny, taskCount: 1000 }, initial);
      expect(keys(exact)).toEqual(['spark.sql.adaptive.coalescePartitions.initialPartitionNum']);
    });

    it('puts parallelismFirst=false first while it is on, because the advisory size alone merges nothing', () => {
      const f = of('tinyTask', { ...tiny, taskCount: 120 }, { 'spark.sql.shuffle.partitions': '400' });
      expect(f.recommendation).toMatch(/parallelismFirst=false.*and then raising/);
      expect(f.recommendation).not.toMatch(/ or raising/);
    });

    it('lowers the property where the stage ran as many tasks as it sets, and with AQE off', () => {
      expect(keys(of('tinyTask', tiny, { 'spark.sql.shuffle.partitions': '400' }))).toEqual(['spark.sql.shuffle.partitions']);
      const aqeOff = of('tinyTask', { ...tiny, taskCount: 120 }, { 'spark.sql.shuffle.partitions': '400', 'spark.sql.adaptive.enabled': 'false' });
      expect(keys(aqeOff)).toEqual(['code']);
    });
  });

  describe('spill', () => {
    /** @type {Partial<Stage>} */
    const spilled = { taskCount: 400, memoryBytesSpilled: 5 * GiB, spillClassification: 'volume', shuffleReadBytes: 10 * GiB };

    it('raises the property only where it sized the stage', () => {
      expect(keys(of('spill', spilled, { 'spark.sql.shuffle.partitions': '400' }))).toEqual(['spark.sql.shuffle.partitions', 'spark.executor.memory']);
    });

    it('lowers the advisory size where AQE coalesced the shuffle', () => {
      const f = of('spill', { ...spilled, taskCount: 120 }, { 'spark.sql.shuffle.partitions': '400' });
      expect(keys(f)).toEqual([ADVISORY, 'spark.executor.memory']);
      expect(f.recommendation).not.toMatch(/spark\.sql\.shuffle\.partitions/);
      expect(coreFindingGenericRecommendation(f)).toMatch(/advisoryPartitionSizeInBytes/);
    });

    it('points at the stage\'s own partition count where a repartition(n) sized it', () => {
      const f = of('spill', spilled, { 'spark.sql.shuffle.partitions': '64' }, '3.5.0', REPARTITIONED);
      expect(keys(f)).toEqual(['code', 'spark.executor.memory']);
      expect(f.recommendation).toMatch(/repartition\(n\)/);
      expect(coreFindingGenericRecommendation(f)).toMatch(/own partition count/);
    });
  });

  describe('a stage whose own exchange the plan shows', () => {
    // Stage 1 reads an exchange that stage 0 wrote; `readDetail` is the AQE read over it, if any.
    /**
     * @param {string} exchangeDetail
     * @param {string | null} readDetail
     * @returns {SqlMap}
     */
    const planWith = (exchangeDetail, readDetail) => {
      /** @type {PlanNode} */
      const exchange = { name: 'Exchange', detail: exchangeDetail, metrics: [], stageIds: [0, 1], exchangeRole: 'read', children: [] };
      /** @type {PlanNode} */
      const queryStage = { name: 'ShuffleQueryStage', detail: '', metrics: [], children: [exchange] };
      /** @type {PlanNode} */
      const below = readDetail == null ? queryStage : { name: 'AQEShuffleRead', detail: readDetail, metrics: [], children: [queryStage] };
      return new Map([[3, { id: 3, planTree: { name: 'AdaptiveSparkPlan', detail: 'isFinalPlan=true', metrics: [], children: [below] } }]]);
    };
    const REPARTITION_NUM = 'Exchange hashpartitioning(k#1L, 300), REPARTITION_BY_NUM, [plan_id=4]';
    const REQUIREMENTS = 'Exchange hashpartitioning(k#1L, 400), ENSURE_REQUIREMENTS, [plan_id=4]';
    const config = { 'spark.sql.shuffle.partitions': '400' };
    /** @type {Partial<Stage>} */
    const spilled = { taskCount: 300, memoryBytesSpilled: 5 * GiB, spillClassification: 'volume', shuffleReadBytes: 10 * GiB };

    it('does not say AQE coalesced a repartition(n) exchange, and offers no advisory size', () => {
      const f = of('spill', spilled, config, '3.5.0', planWith(REPARTITION_NUM, null));
      expect(keys(f)).toEqual(['code', 'spark.executor.memory']);
      expect(f.recommendation).not.toMatch(/AQE|advisoryPartitionSize/);
      expect(f.recommendation).toMatch(/configured shuffle partition count is 400 but this stage ran 300 tasks.*repartition\(n\).*executor memory/);
      expect(coreFindingGenericRecommendation(f)).not.toMatch(/advisoryPartitionSizeInBytes/);
    });

    it('does not say AQE coalesced an exchange that has no AQE shuffle read over it', () => {
      const f = of('spill', spilled, config, '3.5.0', planWith(REQUIREMENTS, null));
      expect(keys(f)).toEqual(['code', 'spark.executor.memory']);
      expect(f.recommendation).not.toMatch(/AQE|advisoryPartitionSize/);
    });

    it('keeps the advisory size where a coalescing AQE read sits over the exchange', () => {
      const f = of('spill', spilled, config, '3.5.0', planWith(REQUIREMENTS, 'coalesced'));
      expect(keys(f)).toEqual([ADVISORY, 'spark.executor.memory']);
      expect(f.recommendation).toMatch(/AQE coalesced the 400 configured shuffle partitions into 300 tasks/);
    });

    it('does not blame AQE for the extra tasks of a repartition(n) exchange with no AQE read', () => {
      // A skew split elsewhere in the execution does not reach a stage whose own exchange AQE left alone.
      const plan = planWith('Exchange hashpartitioning(k#1L, 30000), REPARTITION_BY_NUM, [plan_id=4]', null);
      present(present(plan.get(3)).planTree).children.push({ name: 'AQEShuffleRead', detail: 'skewed', metrics: [], children: [] });
      const f = of('spill', { ...spilled, taskCount: 30000 }, { 'spark.sql.shuffle.partitions': '20003' }, '3.5.0', plan);
      expect(keys(f)).toEqual(['code', 'spark.executor.memory']);
      expect(f.recommendation).not.toMatch(/AQE|spark\.sql\.shuffle\.partitions|advisoryPartitionSize/);
      expect(f.recommendation).toMatch(/configured shuffle partition count is 20003 but this stage ran 30000 tasks.*repartition\(n\)/);
      const split = planWith('Exchange hashpartitioning(k#1L, 20003), ENSURE_REQUIREMENTS, [plan_id=4]', 'skewed');
      expect(keys(of('spill', { ...spilled, taskCount: 20100 }, { 'spark.sql.shuffle.partitions': '20003' }, '3.5.0', split)))
        .toEqual(['spark.sql.shuffle.partitions', 'spark.executor.memory']);
      // A local read after AQE turned the join into a broadcast sizes the stage from the upstream mappers.
      const local = planWith('Exchange hashpartitioning(k#1L, 200), ENSURE_REQUIREMENTS, [plan_id=4]', 'local');
      const probe = of('spill', { ...spilled, taskCount: 5000 }, { 'spark.sql.shuffle.partitions': '200' }, '3.5.0', local);
      expect(keys(probe)).toEqual(['spark.sql.shuffle.partitions', 'spark.executor.memory']);
      expect(probe.recommendation).not.toMatch(/own partition count/);
    });

    it('applies the same classification to the other partition-count findings', () => {
      const tinyStage = { taskCount: 300, taskDurationP50: 50, taskDurationP95: 100, shuffleReadBytes: 10 * MiB };
      expect(keys(of('tinyTask', tinyStage, config, '3.5.0', planWith(REPARTITION_NUM, null)))).toEqual(['code']);
      expect(keys(of('tinyTask', tinyStage, config, '3.5.0', planWith(REQUIREMENTS, 'coalesced')))).toEqual([PARALLELISM_FIRST, ADVISORY]);
      const slow = { taskCount: 300, submittedAt: 0, completedAt: 20 * 60000, shuffleReadBytes: 10 * MiB };
      expect(keys(of('stageSlowness', slow, config, '3.5.0', planWith(REPARTITION_NUM, null)))).toEqual(['code']);
      expect(keys(of('stageSlowness', slow, config, '3.5.0', planWith(REQUIREMENTS, 'coalesced')))).toEqual([ADVISORY]);
    });

    it('keeps the shuffle and low-parallelism advice off the property when the property already exceeds the count', () => {
      const large = { taskCount: 5, shuffleReadBytes: 100 * GiB, shuffleReadP50: 0, shuffleReadMax: 0 };
      const shuffle = of('shuffle', large, config, '3.5.0', planWith(REPARTITION_NUM, null));
      expect(shuffle.partitions).toBe('ownPartitioning');
      expect(shuffle.remediation).toEqual([]);
      expect(shuffle.recommendation).not.toMatch(/increasing spark\.sql\.shuffle\.partitions/);
      const low = present(catalogOf([makeTypedStage({ sqlExecutionId: 3, ...large })], makeApp({ config, sparkVersion: '3.5.0' }), planWith(REPARTITION_NUM, null))
        .find(ofRule('lowShuffleParallelism')));
      expect(low.partitions).toBe('ownPartitioning');
      expect(low.remediation).toEqual([]);
      expect(low.recommendation).toMatch(/repartition\(n\)/);
      for (const f of [shuffle, low]) {
        expect(f.recommendation).toMatch(/spark\.sql\.shuffle\.partitions \(400\) did not size this stage's 5 tasks/);
        expect(f.recommendation).not.toMatch(/already/);
        expect(coreFindingGenericRecommendation(f)).toMatch(/did not size this stage.*own partition count/);
        expect(coreFindingGenericRecommendation(f)).not.toMatch(/already/);
      }
    });
  });

  describe('stageSlowness', () => {
    const slow = { taskCount: 400, submittedAt: 0, completedAt: 20 * 60000, shuffleReadBytes: 10 * MiB };

    it('never offers spark.default.parallelism', () => {
      for (const [stage, config] of /** @type {[Partial<Stage>, Config][]} */ ([[slow, { 'spark.sql.shuffle.partitions': '400' }], [{ ...slow, taskCount: 120 }, { 'spark.sql.shuffle.partitions': '400' }], [slow, { 'spark.sql.shuffle.partitions': '64' }]])) {
        const f = of('stageSlowness', stage, config);
        expect(f.recommendation).not.toMatch(/default\.parallelism/);
        expect(keys(f)).not.toContain('spark.default.parallelism');
        expect(coreFindingGenericRecommendation(f)).not.toMatch(/default\.parallelism/);
      }
    });

    it('sends a stage outside any SQL execution to its own partition count', () => {
      expect(keys(of('stageSlowness', { ...slow, taskCount: 50, sqlExecutionId: null }, { 'spark.sql.shuffle.partitions': '200' }))).toEqual(['code']);
    });

    it('names the lever that sized the stage', () => {
      expect(keys(of('stageSlowness', slow, { 'spark.sql.shuffle.partitions': '400' }))).toEqual(['spark.sql.shuffle.partitions']);
      expect(keys(of('stageSlowness', { ...slow, taskCount: 120 }, { 'spark.sql.shuffle.partitions': '400' }))).toEqual([ADVISORY]);
      expect(keys(of('stageSlowness', slow, { 'spark.sql.shuffle.partitions': '64' }, '3.5.0', REPARTITIONED))).toEqual(['code']);
    });
  });
});
