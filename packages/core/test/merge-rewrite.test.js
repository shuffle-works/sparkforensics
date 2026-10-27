import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyzer.js';
import { collectRun } from '../src/cli/collect-run.ts';
import { makeApp } from './fixtures/stage-app-fixtures.js';

const metrics = (values) => Object.entries(values).map(([name, value]) => ({ name, value, metricType: 'sum' }));

// A MERGE command node with the counters Delta reports; `extra` overrides any of them.
function mergeNode(extra = {}) {
  return {
    id: 'n1', name: 'Execute MergeIntoCommand', detail: '', children: [],
    metrics: metrics({
      'number of inserted rows': 1000, 'number of updated rows': 2000, 'number of deleted rows': 0,
      'number of target rows rewritten unmodified': 5000,
      'number of target files before skipping': 40, 'number of target files after skipping': 4,
      'number of target partitions after skipping': 4, 'number of target partitions from which files were removed': 4,
      ...extra,
    }),
  };
}

function mergeFindings(node) {
  const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree: node }]]);
  return analyze(makeApp(), new Map(), [], [], new Map(), sql).filter((f) => f.type === 'mergeRewrite');
}

describe('mergeRewrite', () => {
  it('stays silent on a MERGE that skips files and rewrites little', () => {
    expect(mergeFindings(mergeNode())).toEqual([]);
  });

  it('flags unmodified rows rewritten at 2x the changed rows and over the floor', () => {
    const [f] = mergeFindings(mergeNode({ 'number of target rows rewritten unmodified': 800_000, 'number of inserted rows': 100_000, 'number of updated rows': 200_000 }));
    expect(f).toMatchObject({ rule: 'rewrittenRows', impactBand: 'info', value: 800_000, rewrittenRows: 800_000, changedRows: 300_000, planNodeIds: ['n1'] });
  });

  it('skips the rows rule below the floor or below the ratio', () => {
    expect(mergeFindings(mergeNode({ 'number of target rows rewritten unmodified': 90_000 }))).toEqual([]);
    expect(mergeFindings(mergeNode({ 'number of target rows rewritten unmodified': 500_000, 'number of updated rows': 300_000 }))).toEqual([]);
  });

  it('flags files kept after skipping while few of the scanned partitions are rewritten', () => {
    const [f] = mergeFindings(mergeNode({
      'number of target files after skipping': 40, 'number of target partitions after skipping': 30,
      'number of target partitions from which files were removed': 2,
    }));
    expect(f).toMatchObject({ rule: 'weakSkipping', value: 40, filesBefore: 40, filesAfter: 40, partitionsScanned: 30, partitionsTouched: 2 });
  });

  it('skips the skipping rule when skipping works, the changes span the scan or the target is unpartitioned', () => {
    expect(mergeFindings(mergeNode({ 'number of target partitions after skipping': 30, 'number of target partitions from which files were removed': 2 }))).toEqual([]);
    expect(mergeFindings(mergeNode({ 'number of target files after skipping': 40, 'number of target partitions after skipping': 4 }))).toEqual([]);
    expect(mergeFindings(mergeNode({ 'number of target files after skipping': 40, 'number of target partitions after skipping': 1, 'number of target partitions from which files were removed': 1 }))).toEqual([]);
  });

  it('counts the partitions an insert added files to as changed', () => {
    const kept = {
      'number of target files after skipping': 40, 'number of target partitions after skipping': 30,
      'number of target partitions from which files were removed': 2,
    };
    expect(mergeFindings(mergeNode({ ...kept, 'number of target partitions to which files were added': 30 }))).toEqual([]);
    expect(mergeFindings(mergeNode({
      ...kept, 'number of target partitions from which files were removed': 0, 'number of target partitions to which files were added': 30,
    }))).toEqual([]);
    const [f] = mergeFindings(mergeNode({ ...kept, 'number of target partitions to which files were added': 3 }));
    expect(f).toMatchObject({ rule: 'weakSkipping', partitionsTouched: 3 });
  });

  it('emits one finding per rule for a MERGE that trips both', () => {
    const rules = mergeFindings(mergeNode({
      'number of target rows rewritten unmodified': 800_000, 'number of target files after skipping': 40,
      'number of target partitions after skipping': 30, 'number of target partitions from which files were removed': 2,
    })).map((f) => f.rule);
    expect(rules).toEqual(['rewrittenRows', 'weakSkipping']);
  });

  it('ignores an UPDATE command node', () => {
    expect(mergeFindings({ ...mergeNode({ 'number of target rows rewritten unmodified': 800_000 }), name: 'Execute UpdateCommand' })).toEqual([]);
  });
});

// dev/log-corpus is a git submodule: the suite skips without it.
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs');
const corpusLog = (name) => join(CORPUS_DIR, `${name}.ndjson`);

async function corpusFindings(name) {
  const { appModel } = await collectRun(corpusLog(name));
  return analyze(appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed, appModel.jobs, appModel.sql, appModel.runAggregates).filter((f) => f.type === 'mergeRewrite');
}

describe('mergeRewrite on public corpus logs', () => {
  it.skipIf(!existsSync(corpusLog('delta-merge-sql')))('flags the SQL MERGE that copied 800000 rows to change 300000', async () => {
    const findings = await corpusFindings('delta-merge-sql');
    expect(findings.map((f) => [f.rule, f.rewrittenRows, f.changedRows])).toEqual([['rewrittenRows', 800_000, 300_000]]);
  });

  it.skipIf(!existsSync(corpusLog('delta-merge-api')))('flags the DeltaTable API MERGE', async () => {
    expect((await corpusFindings('delta-merge-api')).map((f) => f.rule)).toEqual(['rewrittenRows']);
  });

  it.skipIf(!existsSync(corpusLog('delta-concurrent-merge')))('flags both concurrent MERGEs', async () => {
    expect((await corpusFindings('delta-concurrent-merge')).map((f) => [f.executionId, f.rule])).toEqual([[4, 'rewrittenRows'], [3, 'rewrittenRows']]);
  });

  it.skipIf(!existsSync(corpusLog('delta-update')))('stays silent on an UPDATE', async () => {
    expect(await corpusFindings('delta-update')).toEqual([]);
  });
});
