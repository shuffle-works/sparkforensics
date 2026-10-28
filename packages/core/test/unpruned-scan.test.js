import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyzer.js';
import { collectRun } from '../src/cli/collect-run.ts';
import { parseScanFilters } from '../src/plan-summary.ts';
import { makeApp } from './fixtures/stage-app-fixtures.js';

const GIB = 1024 ** 3;
const metrics = (values) => Object.entries(values).map(([name, value]) => ({ name, value, metricType: 'sum' }));

const scanDetail = (partitionFilters, dataFilters) =>
  `FileScan parquet [k#1L,d#2] Batched: true, DataFilters: [${dataFilters}], Format: Parquet, `
  + `Location: PreparedDeltaFileIndex(1 paths)[file:/tmp/events], PartitionFilters: [${partitionFilters}], `
  + 'PushedFilters: [IsNotNull(k), EqualTo(k,3)], ReadSchema: struct<k:bigint>';

// A scan node with the metrics Spark reports; `extra` overrides any of them.
function scanNode({ partitionFilters = '', dataFilters = 'isnotnull(k#1L), (k#1L = 3)', extra = {} } = {}) {
  return {
    id: 'n1', name: 'Scan parquet', detail: scanDetail(partitionFilters, dataFilters), children: [],
    metrics: metrics({ 'number of partitions read': 20, 'size of files read': 4 * GIB, ...extra }),
  };
}

function unprunedFindings(node, thresholds) {
  const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree: node }]]);
  return analyze(makeApp(), new Map(), [], [], new Map(), sql, null, { thresholds }).filter((f) => f.type === 'unprunedScan');
}

describe('parseScanFilters', () => {
  it('reads both filter lists and drops the null checks Spark adds', () => {
    expect(parseScanFilters(scanDetail('isnotnull(d#2), (d#2 = 2026-01-05)', 'isnotnull(k#1L), (k#1L = 3)'))).toEqual({
      partitionFilters: ['isnotnull(d)', '(d = 2026-01-05)'],
      dataFilters: ['(k = 3)'],
    });
  });

  it('returns empty lists for a detail with no filters', () => {
    expect(parseScanFilters(scanDetail('', ''))).toEqual({ partitionFilters: [], dataFilters: [] });
  });

  it('drops the cut last item of a truncated list and stops at the next key', () => {
    const detail = 'FileScan parquet [k#1L,d#2] Batched: true, DataFilters: [isnotnull(store_id#12L), isnotnull(product_id#13L), isnotnull(sa..., '
      + 'Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/tmp/events], PartitionFilters: [isnotnull(d#2), (d#2 = 2026-01-05), (lon..., '
      + 'PushedFilters: [], ReadSchema: struct<k:bigint>';
    expect(parseScanFilters(detail)).toEqual({
      partitionFilters: ['isnotnull(d)', '(d = 2026-01-05)', '(lon...'],
      dataFilters: [],
    });
  });
});

describe('unprunedScan', () => {
  it('flags a partitioned scan that filters rows but no partition', () => {
    const [f] = unprunedFindings(scanNode());
    expect(f).toMatchObject({
      impactBand: 'info', confidence: 'low', value: 4 * GIB, partitionsRead: 20,
      dataFilters: ['(k = 3)'], relation: 'events', planNodeIds: ['n1'],
    });
    expect(f.validationRequired).toMatch(/partitioned by/);
  });

  it('stays silent when a partition filter reached the scan', () => {
    expect(unprunedFindings(scanNode({ partitionFilters: 'isnotnull(d#2), (d#2 = 2026-01-05)' }))).toEqual([]);
  });

  it('stays silent on a scan with no row filter', () => {
    expect(unprunedFindings(scanNode({ dataFilters: '' }))).toEqual([]);
    expect(unprunedFindings(scanNode({ dataFilters: 'isnotnull(k#1L)' }))).toEqual([]);
  });

  it('stays silent on an unpartitioned table, which reports no partition count', () => {
    const node = scanNode();
    node.metrics = metrics({ 'size of files read': 4 * GIB });
    expect(unprunedFindings(node)).toEqual([]);
  });

  it('stays silent below the byte and partition floors', () => {
    expect(unprunedFindings(scanNode({ extra: { 'size of files read': GIB / 2 } }))).toEqual([]);
    expect(unprunedFindings(scanNode({ extra: { 'number of partitions read': 1 } }))).toEqual([]);
  });

  it('stays silent on a Delta log read', () => {
    const node = scanNode();
    node.name = 'Scan json';
    node.detail = 'FileScan json [txn#1] Location: DeltaLogFileIndex(1 paths)[file:/tmp/events/_delta_log/00.json], PartitionFilters: [], DataFilters: []';
    expect(unprunedFindings(node)).toEqual([]);
  });

  it('stays silent on a truncated filter list that holds only null checks', () => {
    expect(unprunedFindings(scanNode({ dataFilters: 'isnotnull(store_id#12L), isnotnull(product_id#13L), isnotnull(sa...' }))).toEqual([]);
  });

  it('merges two unpruned scans of one table in one execution into one finding', () => {
    const left = scanNode();
    const right = { ...scanNode({ dataFilters: 'isnotnull(k#1L), (k#1L = 4)' }), id: 'n2' };
    const join = { id: 'j', name: 'SortMergeJoin', detail: '', metrics: [], children: [left, right] };
    const findings = unprunedFindings(join);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      value: 8 * GIB, partitionsRead: 20, dataFilters: ['(k = 3)', '(k = 4)'], planNodeIds: ['n1', 'n2'],
    });
  });

  it('keeps apart two tables whose paths share a last name', () => {
    const bronze = scanNode();
    bronze.detail = bronze.detail.replace('file:/tmp/events', 'file:/wh/bronze/events');
    const silver = { ...scanNode({ extra: { 'size of files read': 2 * GIB } }), id: 'n2' };
    silver.detail = silver.detail.replace('file:/tmp/events', 'file:/wh/silver/events');
    const join = { id: 'j', name: 'SortMergeJoin', detail: '', metrics: [], children: [bronze, silver] };
    const findings = unprunedFindings(join);
    expect(findings.map((f) => [f.value, f.planNodeIds])).toEqual([[4 * GIB, ['n1']], [2 * GIB, ['n2']]]);
  });

  it('keeps both findings and names each path when same-name tables read equal bytes', () => {
    const bronze = scanNode();
    bronze.detail = bronze.detail.replace('file:/tmp/events', 'file:/wh/bronze/events');
    const silver = { ...scanNode(), id: 'n2' };
    silver.detail = silver.detail.replace('file:/tmp/events', 'file:/wh/silver/events');
    const join = { id: 'j', name: 'SortMergeJoin', detail: '', metrics: [], children: [bronze, silver] };
    const findings = unprunedFindings(join);
    expect(findings.map((f) => [f.relation, f.planNodeIds])).toEqual([
      ['file:/wh/bronze/events', ['n1']], ['file:/wh/silver/events', ['n2']],
    ]);
  });

  it('honors a lowered byte floor', () => {
    expect(unprunedFindings(scanNode({ extra: { 'size of files read': GIB / 2 } }), { unprunedScan: { minBytesRead: 1024 } })).toHaveLength(1);
  });
});

// dev/log-corpus is a git submodule: the suite skips without it.
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs');
const corpusLog = (name) => join(CORPUS_DIR, `${name}.ndjson`);

async function corpusFindings(name, thresholds) {
  const { appModel } = await collectRun(corpusLog(name));
  return analyze(appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed, appModel.jobs, appModel.sql, appModel.runAggregates, { thresholds })
    .filter((f) => f.type === 'unprunedScan');
}

describe('unprunedScan on public corpus logs', () => {
  // The delta-update table is partitioned by `bucket`; its scans filter on `status` and have no partition filter.
  it.skipIf(!existsSync(corpusLog('delta-update')))('flags the partitioned Delta scan that filters on a data column', async () => {
    const findings = await corpusFindings('delta-update', { unprunedScan: { minBytesRead: 0 } });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.dataFilters.length > 0 && f.partitionsRead >= 2)).toBe(true);
  });

  it.skipIf(!existsSync(corpusLog('delta-update')))('stays silent at the default floor, where the table is small', async () => {
    expect(await corpusFindings('delta-update')).toEqual([]);
  });

  it.skipIf(!existsSync(corpusLog('spark-3.5-delta-baseline')))('stays silent on an unpartitioned Delta run even with no byte floor', async () => {
    expect(await corpusFindings('spark-3.5-delta-baseline', { unprunedScan: { minBytesRead: 0 } })).toEqual([]);
  });
});
