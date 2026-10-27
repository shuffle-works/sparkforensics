import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// A 4 GiB executor with 4 cores: (4096 - 300) MiB * 0.6 / 4 = 569.4 MiB (597 MB) of execution memory per task slot.
const FOUR_CORES = { 'spark.executor.memory': '4g', 'spark.executor.cores': '4' };
const VOLUME = { taskCount: 200, shuffleReadBytes: 40 * GiB, memoryBytesSpilled: 5 * GiB, spillClassification: 'volume', peakExecutionMemoryMax: 520 * MiB };

function spillOf(stage, config = FOUR_CORES, sparkVersion = '3.5.0') {
  const cores = Number(config['spark.executor.cores']);
  const app = makeApp({ config, sparkVersion, resources: { executor: { cores, memoryMB: 4096 } } });
  return analyze(app, new Map([[1, makeStage({ id: 1, ...stage })]]), [], [], new Map(), new Map()).find((f) => f.type === 'spill');
}
const keys = (f) => f.remediation.map((r) => r.key);

describe('spill advice from execution memory per task slot', () => {
  it('lowers the executor cores and sizes the shuffle partitions when a task fills its slot', () => {
    const f = spillOf(VOLUME);
    expect(f.recommendation).toContain('raise spark.sql.shuffle.partitions to 320, lower spark.executor.cores to 2 (each of the 4 task slots gets 597 MB of execution memory and a task peaked at 545 MB) or increase executor memory');
    expect(f.remediation).toEqual([
      { kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'increase', suggested: 320 },
      { kind: 'conf', key: 'spark.executor.cores', direction: 'decrease', suggested: 2 },
      { kind: 'conf', key: 'spark.executor.memory', direction: 'increase', suggested: null },
    ]);
  });

  it('uses the logged spark.memory.fraction for the share', () => {
    expect(keys(spillOf(VOLUME, { ...FOUR_CORES, 'spark.memory.fraction': '0.3' }))).toContain('spark.executor.cores');
    expect(keys(spillOf({ ...VOLUME, peakExecutionMemoryMax: 200 * MiB }, { ...FOUR_CORES, 'spark.memory.fraction': '0.8' }))).not.toContain('spark.executor.cores');
  });

  it('leaves the partition count out when the configured one already reaches the ideal size', () => {
    const f = spillOf({ ...VOLUME, shuffleReadBytes: 20 * GiB });
    expect(f.recommendation).toContain('raise spark.sql.shuffle.partitions, lower spark.executor.cores to 2');
    expect(f.remediation[0]).toEqual({ kind: 'conf', key: 'spark.sql.shuffle.partitions', direction: 'increase', suggested: null });
  });

  it('leaves the cores alone when the peak is well under the share', () => {
    const f = spillOf({ ...VOLUME, peakExecutionMemoryMax: 100 * MiB });
    expect(keys(f)).toEqual(['spark.sql.shuffle.partitions', 'spark.executor.memory']);
    expect(f.recommendation).not.toContain('spark.executor.cores');
  });

  it('leaves the cores alone for a single-core executor', () => {
    const f = spillOf(VOLUME, { 'spark.executor.memory': '4g', 'spark.executor.cores': '1' });
    expect(keys(f)).not.toContain('spark.executor.cores');
  });

  it('leaves the cores alone for a spill that is not volume-driven', () => {
    expect(keys(spillOf({ ...VOLUME, spillClassification: 'unclassified' }))).not.toContain('spark.executor.cores');
  });

  it('adds the lever to a stage that reads no shuffle', () => {
    const f = spillOf({ ...VOLUME, shuffleReadBytes: 0, inputBytes: 20 * GiB });
    expect(f.recommendation).toContain('this stage reads no shuffle, so lower spark.executor.cores to 2 (');
    expect(keys(f)).toEqual(['spark.executor.cores', 'spark.executor.memory']);
  });

  it('reads the cores from the executors when the log does not record spark.executor.cores', () => {
    const app = makeApp({ config: { 'spark.executor.memory': '4g' }, sparkVersion: '3.5.0' });
    const added = [{ executorId: '1', timestamp: 0, totalCores: 4 }, { executorId: '2', timestamp: 0, totalCores: 4 }];
    const stages = new Map([[1, makeStage({ id: 1, ...VOLUME })]]);
    const f = analyze(app, stages, added, [], new Map(), new Map()).find((x) => x.type === 'spill');
    expect(keys(f)).toContain('spark.executor.cores');
    const mixed = [added[0], { ...added[1], totalCores: 8 }];
    expect(keys(analyze(app, stages, mixed, [], new Map(), new Map()).find((x) => x.type === 'spill'))).not.toContain('spark.executor.cores');
  });

  it('names the coalesce floor when AQE merged the shuffle into too few tasks', () => {
    const sql = new Map([[3, { id: 3, planTree: { name: 'AdaptiveSparkPlan', detail: 'isFinalPlan=true', metrics: [], children: [] } }]]);
    const app = makeApp({ config: { ...FOUR_CORES, 'spark.sql.shuffle.partitions': '400' }, sparkVersion: '3.5.0', resources: { executor: { cores: 4, memoryMB: 4096 } } });
    const stage = makeStage({ id: 1, sqlExecutionId: 3, ...VOLUME, taskCount: 100 });
    const f = analyze(app, new Map([[1, stage]]), [], [], new Map(), sql).find((x) => x.type === 'spill');
    expect(f.recommendation).toContain('set spark.sql.adaptive.coalescePartitions.minPartitionNum to 320, lower spark.executor.cores to 2');
    expect(f.remediation).toContainEqual({ kind: 'conf', key: 'spark.sql.adaptive.coalescePartitions.minPartitionNum', direction: 'set', suggested: 320 });
  });
});
