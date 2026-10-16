import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.ts';
import { buildEvidenceReport } from '../src/evidence-report.ts';

// Write targets on the public corpus's Delta DML runs: one table written, then merged into, updated
// or deleted from in a local session. dev/log-corpus is a git submodule: the suite skips without it.
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs');
const corpusLog = (name) => join(CORPUS_DIR, `${name}.ndjson`);

const TABLE_PATH = '/tmp/spark-workload-output/data-delta-table';
// The initial save names its table as a plain path; a DML command's target is read from the
// `_delta_log` scans of its executions, which print it as a file URI.
const SAVE = { command: 'SaveIntoDataSourceCommand', kind: 'path', target: TABLE_PATH };
const dml = (command) => ({ command, kind: 'path', target: `file://${TABLE_PATH}` });

async function writesOf(name) {
  const { appModel, skippedLines } = await collectRun(corpusLog(name));
  const { writeTargets } = buildEvidenceReport(appModel, { markdown: false }).json;
  expect(writeTargets.skippedLines).toBe(skippedLines);
  expect(writeTargets.executionsWithoutPlan).toEqual([]);
  return writeTargets.writes.map(({ sqlExecutionId, command, kind, target, recognized }) =>
    ({ sqlExecutionId, command, kind, target, recognized }));
}

describe('Delta DML write targets on public corpus logs', () => {
  it.skipIf(!existsSync(corpusLog('delta-merge-sql')))('names the table of a SQL MERGE', async () => {
    expect(await writesOf('delta-merge-sql')).toEqual([
      { sqlExecutionId: 0, recognized: true, ...SAVE },
      { sqlExecutionId: 4, recognized: true, ...dml('MergeIntoCommand') },
    ]);
  });

  it.skipIf(!existsSync(corpusLog('delta-update')))('names the table of an UPDATE', async () => {
    expect(await writesOf('delta-update')).toEqual([
      { sqlExecutionId: 0, recognized: true, ...SAVE },
      { sqlExecutionId: 3, recognized: true, ...dml('UpdateCommand') },
    ]);
  });

  it.skipIf(!existsSync(corpusLog('delta-delete')))('names the table of a DELETE', async () => {
    expect(await writesOf('delta-delete')).toEqual([
      { sqlExecutionId: 0, recognized: true, ...SAVE },
      { sqlExecutionId: 3, recognized: true, ...dml('DeleteCommand') },
    ]);
  });

  // Two threads each run a MERGE in one session: two root executions, interleaved sub-queries.
  it.skipIf(!existsSync(corpusLog('delta-concurrent-merge')))('names the table of both concurrent MERGEs', async () => {
    expect(await writesOf('delta-concurrent-merge')).toEqual([
      { sqlExecutionId: 0, recognized: true, ...SAVE },
      { sqlExecutionId: 3, recognized: true, ...dml('MergeIntoCommand') },
      { sqlExecutionId: 4, recognized: true, ...dml('MergeIntoCommand') },
    ]);
  });

  // The DeltaTable API runs its merge as a MergeIntoCommand execution, so it is reported as one
  // command write, not as a DeltaMerge group of sub-queries.
  it.skipIf(!existsSync(corpusLog('delta-merge-api')))('reports the DeltaTable API merge as a MergeIntoCommand write', async () => {
    const writes = await writesOf('delta-merge-api');
    expect(writes.map((w) => w.command)).toEqual(['SaveIntoDataSourceCommand', 'MergeIntoCommand']);
    expect(writes[1]).toMatchObject({ sqlExecutionId: 3, recognized: true, kind: 'path', target: `file://${TABLE_PATH}` });
  });
});

// A MERGE's row counts sit on its command node's SQL metrics; `outputRows` is the sum of the rows it wrote.
describe('MERGE row counts on public corpus logs', () => {
  const MERGE_ROWS = { inserted: 100000, updated: 200000, deleted: 0, copied: 800000 };

  async function mergeWrite(name) {
    const { appModel } = await collectRun(corpusLog(name));
    const { writeTargets } = buildEvidenceReport(appModel, { markdown: false }).json;
    return writeTargets.writes.find((w) => w.command === 'MergeIntoCommand');
  }

  it.skipIf(!existsSync(corpusLog('delta-merge-sql')))('reads them from a SQL MERGE node', async () => {
    const write = await mergeWrite('delta-merge-sql');
    expect(write.mergeRows).toEqual(MERGE_ROWS);
    expect(write.outputRows).toBe(1_100_000);
  });

  it.skipIf(!existsSync(corpusLog('delta-merge-api')))('reads them from a DeltaTable API merge that has a command node', async () => {
    expect((await mergeWrite('delta-merge-api')).mergeRows).toEqual(MERGE_ROWS);
  });
});

// Rows and bytes a MERGE, UPDATE or DELETE wrote to new files come from its command node's counters,
// and equal the stage sums of its root execution.
describe('DML output figures on public corpus logs', () => {
  async function dmlWrites(name) {
    const { appModel } = await collectRun(corpusLog(name));
    const { writeTargets } = buildEvidenceReport(appModel, { markdown: false }).json;
    return writeTargets.writes.filter((w) => w.command !== 'SaveIntoDataSourceCommand');
  }
  const figures = ({ outputRows, outputRowsSource, outputBytes }) => ({ outputRows, outputRowsSource, outputBytes });

  it.skipIf(!existsSync(corpusLog('delta-merge-sql')))('reports inserted + updated + copied rows and the bytes added for a SQL MERGE', async () => {
    const [merge] = await dmlWrites('delta-merge-sql');
    expect(figures(merge)).toEqual({ outputRows: 1_100_000, outputRowsSource: 'commandMetric', outputBytes: 14_314_600 });
    expect(merge.changedRows).toBeNull();
  });

  it.skipIf(!existsSync(corpusLog('delta-merge-api')))('reports the same figures for a DeltaTable API merge', async () => {
    const [merge] = await dmlWrites('delta-merge-api');
    expect(figures(merge)).toEqual({ outputRows: 1_100_000, outputRowsSource: 'commandMetric', outputBytes: 14_314_661 });
  });

  it.skipIf(!existsSync(corpusLog('delta-concurrent-merge')))('reports each concurrent MERGE from its own node', async () => {
    const merges = await dmlWrites('delta-concurrent-merge');
    expect(merges.map((w) => [w.sqlExecutionId, ...Object.values(figures(w))])).toEqual([
      [3, 275_000, 'commandMetric', 3_578_545],
      [4, 275_000, 'commandMetric', 3_578_577],
    ]);
  });

  it.skipIf(!existsSync(corpusLog('delta-update')))('reports the rows touched, the bytes added and the updated count for an UPDATE', async () => {
    const [update] = await dmlWrites('delta-update');
    expect(figures(update)).toEqual({ outputRows: 500_000, outputRowsSource: 'commandMetric', outputBytes: 6_010_388 });
    expect(update.changedRows).toEqual({ updated: 100_000, deleted: null });
    expect(update.mergeRows).toBeNull();
  });

  it.skipIf(!existsSync(corpusLog('delta-delete')))('reports 0 rows and 0 bytes written, and the deleted count, for a DELETE', async () => {
    const [del] = await dmlWrites('delta-delete');
    expect(figures(del)).toEqual({ outputRows: 0, outputRowsSource: 'commandMetric', outputBytes: 0 });
    expect(del.changedRows).toEqual({ updated: null, deleted: 250_000 });
  });
});
