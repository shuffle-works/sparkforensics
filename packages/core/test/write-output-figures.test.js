import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRun, emptyAppModel } from '../src/cli/collect-run.ts';
import { buildEvidenceReport } from '../src/evidence-report.ts';
import { extractWriteTargets } from '../src/write-targets.ts';

// Output rows and bytes of a write, on public corpus logs. dev/log-corpus is a git submodule: the
// corpus cases skip without it.
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs');
const corpusLog = (name) => join(CORPUS_DIR, `${name}.ndjson`);

async function reportOf(name) {
  const { appModel } = await collectRun(corpusLog(name));
  return buildEvidenceReport(appModel, { markdown: false }).json;
}

const figures = (w) => ({ command: w.command, rows: w.outputRows, source: w.outputRowsSource, hasBytes: w.outputBytes !== null });
const noFigureCheck = (json) => json.notRunChecks.find((c) => c.type === 'writeOutputRows');

describe('write output figures on public corpus logs', () => {
  it.skipIf(!existsSync(corpusLog('spark-3.5-delta-baseline')))('sums the stages of the root execution for a Delta DataFrame write', async () => {
    const json = await reportOf('spark-3.5-delta-baseline');
    expect(json.writeTargets.writes.map(figures)).toEqual([
      { command: 'SaveIntoDataSourceCommand', rows: 5_000_000, source: 'stageSum', hasBytes: true },
    ]);
    expect(json.writeTargets.writes[0].outputBytes).toBeGreaterThan(0);
    expect(noFigureCheck(json)).toBeUndefined();
  });

  it.skipIf(!existsSync(corpusLog('spark-3.5-parquet-baseline')))('keeps the node metric for a Parquet write', async () => {
    const json = await reportOf('spark-3.5-parquet-baseline');
    expect(json.writeTargets.writes.map(figures)).toEqual([
      { command: 'InsertIntoHadoopFsRelationCommand', rows: 5_000_000, source: 'nodeMetric', hasBytes: true },
    ]);
    expect(noFigureCheck(json)).toBeUndefined();
  });

  it.skipIf(!existsSync(corpusLog('spark-3.5-iceberg-baseline')))('gives an Iceberg replace and its overwrite the same figure', async () => {
    const json = await reportOf('spark-3.5-iceberg-baseline');
    expect(json.writeTargets.writes.map(figures)).toEqual([
      { command: 'AtomicReplaceTableAsSelect', rows: 5_000_000, source: 'stageSum', hasBytes: true },
      { command: 'OverwriteByExpression', rows: 5_000_000, source: 'stageSum', hasBytes: true },
    ]);
    expect(noFigureCheck(json)).toBeUndefined();
  });

  it.skipIf(!existsSync(corpusLog('delta-merge-sql')))('leaves a MERGE to mergeRows, with no stage sum', async () => {
    const [save, merge] = (await reportOf('delta-merge-sql')).writeTargets.writes;
    expect(save).toMatchObject({ command: 'SaveIntoDataSourceCommand', outputRows: 1_000_000, outputRowsSource: 'stageSum' });
    expect(merge).toMatchObject({ command: 'MergeIntoCommand', outputRows: null, outputRowsSource: null, outputBytes: null });
    expect(merge.mergeRows.inserted).toBeGreaterThan(0);
  });
});

describe('write output figures on a hand-built plan', () => {
  const write = (command) => ({ name: `Execute ${command}`, detail: `Execute ${command}`, metrics: [], children: [] });
  const stage = (id, sqlExecutionId, outputRecords, outputBytes = 10) => [id, { id, sqlExecutionId, outputRecords, outputBytes }];
  const run = (execs, stages) => {
    const sql = new Map(execs.map((e) => [e.id, { planTree: null, ...e }]));
    return extractWriteTargets(sql, { stages: new Map(stages) }).writes;
  };

  it('reports 0 for a write whose stages stored no rows', () => {
    const [w] = run([{ id: 0, rootExecutionId: 0, planTree: write('SaveIntoDataSourceCommand') }, { id: 1, rootExecutionId: 0 }],
      [stage(1, 1, 0, 0)]);
    expect(w).toMatchObject({ outputRows: 0, outputRowsSource: 'stageSum', outputBytes: 0 });
  });

  it('stays null when no stage of the root reports rows written', () => {
    const [w] = run([{ id: 0, rootExecutionId: 0, planTree: write('SaveIntoDataSourceCommand') }, { id: 1, rootExecutionId: 0 }],
      [stage(1, 1, null)]);
    expect(w).toMatchObject({ outputRows: null, outputRowsSource: null });
  });

  it('leaves outputBytes null when no stage of the root reports bytes written', () => {
    const [w] = run([{ id: 0, rootExecutionId: 0, planTree: write('SaveIntoDataSourceCommand') }, { id: 1, rootExecutionId: 0 }],
      [[1, { id: 1, sqlExecutionId: 1 }]]);
    expect(w.outputBytes).toBeNull();
  });

  it('stays null when the root holds two different write targets', () => {
    const writes = run([
      { id: 0, rootExecutionId: 0, planTree: write('SaveIntoDataSourceCommand') },
      { id: 1, rootExecutionId: 0, planTree: write('SaveIntoDataSourceCommand') },
    ], [stage(1, 1, 7)]);
    expect(writes.map((w) => w.outputRows)).toEqual([null, null]);
  });

  it('never sums stages for an UPDATE', () => {
    const [w] = run([{ id: 0, rootExecutionId: 0, planTree: write('UpdateCommand') }, { id: 1, rootExecutionId: 0 }],
      [stage(1, 1, 9)]);
    expect(w).toMatchObject({ outputRows: null, outputRowsSource: null, outputBytes: null });
  });

  it('lists a plain write without a figure in notRunChecks, and not an UPDATE', () => {
    const report = (command) => {
      const sql = new Map([[0, { id: 0, rootExecutionId: 0, planTree: write(command) }]]);
      return buildEvidenceReport({ ...emptyAppModel(), sql }, { markdown: false }).json;
    };
    expect(noFigureCheck(report('SaveIntoDataSourceCommand')).reason).toContain('execution 0 SaveIntoDataSourceCommand');
    expect(noFigureCheck(report('UpdateCommand'))).toBeUndefined();
  });
});
