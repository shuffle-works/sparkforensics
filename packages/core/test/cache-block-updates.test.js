import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { collectRun } from '../src/cli/collect-run.js';
import { analyze } from '../src/analyzer.js';

// Hand-built Spark 3.5 log with spark.eventLog.logBlockUpdates.enabled=true and reduced storage
// memory: a MEMORY_ONLY RDD with 4 of 10 partitions cached (later unpersisted), and a
// MEMORY_AND_DISK RDD with 7 of its 10 partitions' bytes on disk. RDD Info carries the 0s that
// Spark 2.3+ always writes, so only the block updates can produce these findings.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cache-block-updates.ndjson');

async function cacheFindings(path) {
  const { appModel: m } = await collectRun(path);
  return analyze(m.app, m.stages, m.executors.added, m.executors.removed, m.jobs, m.sql, m.runAggregates)
    .filter((f) => f.type === 'cacheUtilization');
}

describe('cacheUtilization end to end on a block-update log', () => {
  it('flags the MEMORY_ONLY RDD as partially cached and the MEMORY_AND_DISK RDD as spilled to disk', async () => {
    const findings = await cacheFindings(FIXTURE);
    expect(findings.map(({ variant, rddId, impactBand, value }) => ({ variant, rddId, impactBand, value }))).toEqual(
      expect.arrayContaining([
        { variant: 'partialCache', rddId: 4, impactBand: 'warning', value: 40 },
        { variant: 'diskSpillover', rddId: 9, impactBand: 'warning', value: 70 },
      ]),
    );
    expect(findings).toHaveLength(2);
  });

  it('reports missing evidence, not a clean cache, when the same run was logged without block updates', async () => {
    const withoutBlocks = readFileSync(FIXTURE, 'utf8').split('\n')
      .filter((line) => !line.includes('"SparkListenerBlockUpdated"'))
      .join('\n')
      .replace('"spark.eventLog.logBlockUpdates.enabled":"true",', '');
    const path = join(mkdtempSync(join(tmpdir(), 'cache-block-updates-')), 'no-block-updates.ndjson');
    writeFileSync(path, withoutBlocks);
    const findings = await cacheFindings(path);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ variant: 'storageUnobserved', dataUnavailable: true, value: 2 });
    expect(findings[0].recommendation).toContain('spark.eventLog.logBlockUpdates.enabled=true');
  });
});
