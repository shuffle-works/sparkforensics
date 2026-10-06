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
