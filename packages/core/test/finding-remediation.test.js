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
  it('sizes lowShuffleParallelism to the ideal partition size the estimate uses', () => {
    const f = catalogOf([makeStage({ shuffleReadBytes: 2 * 1024 * MiB, taskCount: 5, shuffleReadP50: 0, shuffleReadMax: 0 })])
      .find((x) => x.rule === 'lowShuffleParallelism');
    // 2 GiB / 128 MiB
    expect(f.remediation).toEqual([
      { kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'increase', suggested: 16 },
    ]);
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
});
