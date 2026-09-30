import { describe, it, expect } from 'vitest';
import { analyze, auditConfig } from '../src/analyzer.js';
import { buildEvidenceReport } from '../src/evidence-report.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

const MiB = 1024 * 1024;
const KRYO = 'org.apache.spark.serializer.KryoSerializer';

function catalogOf(stages, app = makeApp()) {
  return analyze(app, new Map(stages.map((s) => [s.id, s])), [], []);
}

describe('structured remediation', () => {
  describe('lowShuffleParallelism against the logged shuffle partition count', () => {
    const finding = (config) => catalogOf(
      [makeStage({ shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0 })],
      makeApp({ config }),
    ).find((x) => x.rule === 'lowShuffleParallelism');
    const run = (config) => finding(config).remediation;
    const increase = (suggested) => [{ kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'increase', suggested }];

    it('suggests the count that reaches the ideal partition size when the logged value is below it', () => {
      // 2 GiB / 128 MiB
      expect(run({ 'spark.sql.shuffle.partitions': '8' })).toEqual(increase(16));
    });

    it('leaves suggested null when the property is not logged', () => {
      expect(run({})).toEqual(increase(null));
    });

    it('suggests nothing when the logged value is already at or above the count, since it does not limit that stage', () => {
      expect(run({ 'spark.sql.shuffle.partitions': '200' })).toEqual([]);
      expect(run({ 'spark.sql.shuffle.partitions': '16' })).toEqual([]);
    });

    it('points the text at the stage\'s own partitioning, not the property, when the logged value is already enough', () => {
      const { recommendation } = finding({ 'spark.sql.shuffle.partitions': '200' });
      expect(recommendation).not.toMatch(/raise spark\.sql\.shuffle\.partitions/);
      expect(recommendation).toMatch(/repartition\(n\)/);
      for (const config of [{}, { 'spark.sql.shuffle.partitions': '8' }]) {
        expect(finding(config).recommendation).toMatch(/raise spark\.sql\.shuffle\.partitions/);
      }
    });
  });

  describe('coldStart dynamic allocation remediation', () => {
    const coldStart = (app) => analyze(
      app, new Map([[1, makeStage({ id: 1, submittedAt: 60_000, completedAt: 70_000 })]]),
      [{ executorId: '1', timestamp: 120_000, totalCores: 4 }], [], new Map(),
    ).find((f) => f.type === 'coldStart');
    const app = (config, resources) => makeApp({ endTime: 200_000, config, resources });

    it('suggests raising min and initial executors unless dynamic allocation is explicitly off', () => {
      for (const a of [app({}), app({ 'spark.dynamicAllocation.enabled': 'true' }, { dynamicAllocationEnabled: true })]) {
        expect(coldStart(a).remediation.map((r) => r.key)).toEqual([
          'spark.dynamicAllocation.minExecutors', 'spark.dynamicAllocation.initialExecutors',
        ]);
      }
    });

    it('suggests nothing when the logged conf has dynamic allocation off', () => {
      expect(coldStart(app({ 'spark.dynamicAllocation.enabled': 'false' }, { dynamicAllocationEnabled: false })).remediation).toEqual([]);
      expect(coldStart(app({ 'spark.dynamicAllocation.enabled': 'FALSE' })).remediation).toEqual([]);
    });
  });

  it('lowers shuffle partitions for a tinyTask finding on a shuffle stage with no suggested value, and none off one', () => {
    const tiny = { taskCount: 150, taskDurationP50: 80, taskDurationP95: 150 };
    const onShuffle = catalogOf([makeStage({ ...tiny, shuffleReadBytes: 10 * MiB })]).find((x) => x.type === 'tinyTask');
    expect(onShuffle.remediation).toEqual([
      { kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'decrease', suggested: null },
    ]);
    const noShuffle = catalogOf([makeStage(tiny)]).find((x) => x.type === 'tinyTask');
    expect(noShuffle.remediation).toEqual([]);
  });

  it('leaves suggested null where the detector computes no value', () => {
    const f = catalogOf([makeStage({ shuffleReadBytes: 200 * MiB })]).find((x) => x.type === 'shuffle');
    expect(f.remediation).toEqual([
      { kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'increase', suggested: null },
    ]);
  });

  it('gives a skew-driven spill no remediation, since more memory will not help', () => {
    const f = catalogOf([makeStage({ memoryBytesSpilled: 2048 * MiB, spillClassification: 'skew' })]).find((x) => x.type === 'spill');
    expect(f.remediation).toEqual([]);
  });

  it('names the serializer class and the memoryOverhead floor from the audited config', () => {
    const app = {
      config: { 'spark.executor.memory': '10g', 'spark.executor.memoryOverhead': '256' },
      resources: { executor: { memoryMB: 10240, memoryOverheadMB: 256 }, driver: {}, serializer: null },
    };
    const findings = auditConfig(app);
    expect(findings.find((x) => x.property === 'spark.serializer').remediation).toEqual([
      { kind: 'conf', key: 'spark.serializer', direction: 'set', suggested: KRYO },
    ]);
    expect(findings.find((x) => x.property === 'spark.executor.memoryOverhead').remediation).toEqual([
      { kind: 'conf', key: 'spark.executor.memoryOverhead', direction: 'increase', suggested: '1024m' },
    ]);
  });

  it('suggests the max bound for an inverted min/max pair', () => {
    const app = {
      config: { 'spark.dynamicAllocation.minExecutors': '10', 'spark.dynamicAllocation.maxExecutors': '5', 'spark.serializer': KRYO },
      resources: { executor: {}, driver: {}, dynamicAllocationEnabled: true, shuffleServiceEnabled: true, serializer: KRYO },
    };
    const f = auditConfig(app).find((x) => x.property === 'spark.dynamicAllocation.minExecutors');
    expect(f.remediation).toEqual([
      { kind: 'conf', key: 'spark.dynamicAllocation.minExecutors', direction: 'decrease', suggested: 5 },
    ]);
  });

  it('carries a remediation entry for every property a recommendation names, bar the ones with no stated direction', () => {
    // autoscalingChurn names its bounds without saying which way to move each.
    const NO_DIRECTION = new Set(['spark.dynamicAllocation.minExecutors', 'spark.dynamicAllocation.maxExecutors']);
    const findings = [
      ...catalogOf([
        makeStage({ id: 1, shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0, gcPct: 40, jvmGCTime: 4000, memoryBytesSpilled: 3000 * MiB }),
        makeStage({ id: 2, taskCount: 150, taskDurationP50: 80, taskDurationP95: 150, shuffleReadBytes: 10 * MiB }),
        makeStage({ id: 3, taskDurationP50: 100, taskDurationP95: 900, taskDurationMax: 2000 }),
        makeStage({ id: 4, shuffleReadBytes: 300 * MiB, completedAt: 20 * 60_000 }),
        makeStage({ id: 5, speculationWastedAttempts: 10, speculationWasteMs: 120_000 }),
        makeStage({ id: 6, localityStats: [{ locality: 'PROCESS_LOCAL', count: 50 }, { locality: 'ANY', count: 50 }] }),
      ]),
      ...auditConfig({ config: {}, resources: { executor: { memoryMB: 10240, memoryOverheadMB: 256 }, driver: {}, dynamicAllocationEnabled: true, shuffleServiceEnabled: false, serializer: null } }),
    ];
    expect(findings.some((f) => f.type === 'coreLocality')).toBe(true);
    let checked = 0;
    for (const f of findings) {
      const named = new Set((f.recommendation ?? '').match(/spark\.[A-Za-z.]*[A-Za-z]/g) ?? []);
      const emitted = new Set((f.remediation ?? []).map((r) => r.key));
      for (const key of named) {
        if (NO_DIRECTION.has(key)) continue;
        checked += 1;
        expect(emitted.has(key), `${f.type}: ${key}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('emits only well-formed entries', () => {
    const findings = [
      ...catalogOf([
        makeStage({ id: 1, shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0, gcPct: 40, jvmGCTime: 4000, memoryBytesSpilled: 3000 * MiB }),
        makeStage({ id: 2, taskCount: 150, taskDurationP50: 80, taskDurationP95: 150, shuffleReadBytes: 10 * MiB }),
        makeStage({ id: 3, taskDurationP50: 100, taskDurationP95: 900, taskDurationMax: 2000 }),
        makeStage({ id: 4, shuffleReadBytes: 300 * MiB }),
      ]),
      ...auditConfig({ config: {}, resources: { executor: {}, driver: {}, dynamicAllocationEnabled: true, shuffleServiceEnabled: false, serializer: null } }),
    ];
    const withRemediation = findings.filter((f) => f.remediation?.length);
    expect(withRemediation.length).toBeGreaterThan(3);
    for (const f of withRemediation) {
      for (const r of f.remediation) {
        expect(r.kind).toBe('conf');
        expect(['increase', 'decrease', 'set']).toContain(r.direction);
        expect(['number', 'string', 'boolean', 'object']).toContain(typeof r.suggested); // object: null
        expect(r.key, f.type).toMatch(/^spark\./);
      }
    }
  });

  it('reports remediation on every evidence-report row, empty when none applies', () => {
    const fx = {
      app: makeApp(),
      stages: new Map([
        [1, makeStage({ id: 1, shuffleReadBytes: 300 * MiB })],
        [2, makeStage({ id: 2, taskDurationP50: 100, taskDurationP95: 600 })],
      ]),
      executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null,
    };
    const { json } = buildEvidenceReport(fx);
    for (const row of json.findings) expect(Array.isArray(row.remediation), row.type).toBe(true);
    expect(json.findings.find((r) => r.type === 'shuffle').remediation[0].key).toBe('spark.sql.shuffle.partitions');
  });

  describe('dynamic allocation remediation follows the effective conf', () => {
    const lowUtil = (app) => {
      const stages = new Map([[1, makeStage({ id: 1 })]]);
      const added = [{ executorId: '1', timestamp: 0, totalCores: 4 }];
      return analyze(app, stages, added, [], new Map(), new Map(), { busyCoreMs: 100 });
    };
    const idleCores = (app) => lowUtil(app).find((f) => f.type === 'memoryUtilization' && f.variant === 'idleCores');
    const utilization = (app) => lowUtil(app).find((f) => f.type === 'utilization');
    const enable = [{ kind: 'conf', key: 'spark.dynamicAllocation.enabled', direction: 'set', suggested: true }];

    it('suggests enabling it when the run has it off or unset', () => {
      const off = makeApp({ config: { 'spark.dynamicAllocation.enabled': 'false' }, resources: { dynamicAllocationEnabled: false } });
      for (const app of [off, makeApp()]) {
        expect(utilization(app).remediation).toEqual(enable);
        expect(idleCores(app).remediation).toEqual(enable);
      }
    });

    it('suggests nothing when the run already has it on', () => {
      const viaResources = makeApp({ resources: { dynamicAllocationEnabled: true } });
      const viaConfig = makeApp({ config: { 'spark.dynamicAllocation.enabled': 'true' } });
      for (const app of [viaResources, viaConfig]) {
        expect(utilization(app).remediation).toEqual([]);
        expect(idleCores(app).remediation).toEqual([]);
      }
    });
  });

  describe('a set-to-value remediation follows the logged conf', () => {
    const skewStage = makeStage({ id: 1, taskDurationP50: 100, taskDurationP95: 600 });
    const partitionSkewStage = makeStage({ id: 2, shuffleReadP50: 10 * MiB, shuffleReadMax: 300 * MiB, shuffleReadBytes: 400 * MiB, taskCount: 50 });
    const slowHostStage = makeStage({
      id: 3, taskCount: 60,
      hostStats: [
        { host: 'a', taskCount: 20, totalDuration: 200000 },
        { host: 'b', taskCount: 20, totalDuration: 200000 },
        { host: 'c', taskCount: 20, totalDuration: 600000 },
      ],
    });
    const pick = (config) => {
      const on = (stage) => catalogOf([stage], makeApp({ config }));
      return {
        skew: on(skewStage).find((f) => f.type === 'skew'),
        partitionSkew: on(partitionSkewStage).find((f) => f.rule === 'shufflePartitionSkew'),
        slowHost: on(slowHostStage).find((f) => f.type === 'slowHost'),
      };
    };
    const set = (key) => [{ kind: 'conf', key, direction: 'set', suggested: true }];

    it('suggests the switch when the run has it off or unset', () => {
      for (const config of [{}, { 'spark.sql.adaptive.skewJoin.enabled': 'false', 'spark.speculation': 'false' }]) {
        const { skew, partitionSkew, slowHost } = pick(config);
        expect(skew.remediation).toEqual(set('spark.sql.adaptive.skewJoin.enabled'));
        expect(partitionSkew.remediation).toEqual(set('spark.sql.adaptive.skewJoin.enabled'));
        expect(slowHost.remediation).toEqual(set('spark.speculation'));
      }
    });

    it('suggests nothing when the logged conf already has it, compared case-insensitively', () => {
      const { skew, partitionSkew, slowHost } = pick({ 'spark.sql.adaptive.skewJoin.enabled': 'TRUE', 'spark.speculation': 'True' });
      expect(skew.remediation).toEqual([]);
      expect(partitionSkew.remediation).toEqual([]);
      expect(slowHost.remediation).toEqual([]);
    });

    it('suggests Kryo unless the logged serializer is already Kryo', () => {
      const res = { executor: {}, driver: {}, dynamicAllocationEnabled: false, shuffleServiceEnabled: true, serializer: null };
      const java = auditConfig({ config: { 'spark.app.name': 'x' }, resources: res }).find((f) => f.property === 'spark.serializer');
      expect(java.remediation).toEqual([{ kind: 'conf', key: 'spark.serializer', direction: 'set', suggested: KRYO }]);
      const kryo = auditConfig({ config: { 'spark.serializer': KRYO }, resources: res }).find((f) => f.property === 'spark.serializer');
      expect(kryo).toBeUndefined();
    });
  });
});
