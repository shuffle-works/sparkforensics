import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractWriteTargets } from '../src/write-targets.ts';
import { buildEvidenceReport } from '../src/evidence-report.ts';
import { emptyAppModel } from '../src/cli/collect-run.ts';

const fixture = (name) => JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8'));

const node = (name, detail, extra = {}) => ({ name, detail, metrics: [], children: [], ...extra });
const sqlOf = (...plans) => new Map(plans.map((planTree, i) => [i, { id: i, planTree }]));
const writesOf = (plan) => extractWriteTargets(sqlOf(plan)).writes;

describe('extractWriteTargets', () => {
  const cases = fixture('write-node-details.json');
  it.each(cases)('$case', ({ name, detail, kind, target }) => {
    const [write] = writesOf(node(name, detail, { id: 'n1' }));
    expect(write).toMatchObject({ command: name.replace(/^Execute /, ''), recognized: true, kind, target, raw: detail });
  });

  it('reports the real truncated InsertIntoHadoopFsRelationCommand with its complete path', () => {
    const { planTree } = fixture('plan-graph-stage-394.json');
    const writes = writesOf(planTree);
    expect(writes).toHaveLength(1);
    // "... 13 more fields" cuts the column list that follows the path, not the path.
    expect(writes[0]).toMatchObject({ command: 'InsertIntoHadoopFsRelationCommand', kind: 'path', target: '/path_1', outputRows: null });
    expect(writes[0].raw).toMatch(/13 more fields\]$/);
  });

  it('never reports a partial target: null unless a delimiter follows the whole target', () => {
    for (const { detail, name } of cases.filter((c) => c.target === null)) {
      const [write] = writesOf(node(name, detail));
      expect(write.target).toBeNull();
      expect(write.kind).toBeNull();
      expect(write.raw).toBe(detail);
    }
  });

  it('reports a write-like node outside the known list as an unrecognized write', () => {
    const writes = writesOf(node('Execute SomeVendorOverwriteCommand', 'Execute SomeVendorOverwriteCommand /sandbox/x, true'));
    expect(writes).toEqual([expect.objectContaining({
      command: 'SomeVendorOverwriteCommand', recognized: false, kind: null, target: null,
      raw: 'Execute SomeVendorOverwriteCommand /sandbox/x, true',
    })]);
  });

  it('reports every recognized command as a recognized write, and other non-SQL-verb writes as unrecognized', () => {
    const known = [
      'InsertIntoHadoopFsRelationCommand', 'InsertIntoHiveTable', 'CreateDataSourceTableAsSelectCommand',
      'CreateHiveTableAsSelectCommand', 'SaveIntoDataSourceCommand', 'AppendData', 'OverwriteByExpression',
      'OverwritePartitionsDynamic', 'ReplaceData', 'WriteDelta', 'WriteToDataSourceV2', 'CreateTableAsSelect',
      'AtomicCreateTableAsSelect', 'ReplaceTableAsSelect', 'AtomicReplaceTableAsSelect', 'WriteIntoDelta',
      'WriteIntoDeltaCommand', 'MergeIntoCommand', 'UpdateCommand', 'DeleteCommand', 'CreateDeltaTableCommand',
      'OptimizeTableCommand', 'RestoreTableCommand',
    ];
    for (const command of known) {
      expect(writesOf(node(`Execute ${command}`, `Execute ${command}`))).toEqual([
        expect.objectContaining({ command, recognized: true, target: null }),
      ]);
    }
    for (const command of ['LoadDataCommand', 'VacuumCommand', 'ConvertToDeltaCommand', 'CloneTableCommand']) {
      expect(writesOf(node(`Execute ${command}`, `Execute ${command}`))).toEqual([
        expect.objectContaining({ command, recognized: false, target: null }),
      ]);
    }
  });

  it('does not treat read and query operators as writes', () => {
    const plan = node('WriteFiles', 'WriteFiles', { children: [
      node('SortMergeJoin', 'SortMergeJoin [a#1], [b#2], Inner'),
      node('AppendColumns', 'AppendColumns x'),
      node('MergeRows', 'MergeRows'),
      node('StateStoreRestore', 'StateStoreRestore [k#1], state info [ checkpoint = file:/c, runId = r, opId = 0, ver = 0, numPartitions = 2]'),
      node('SessionWindowStateStoreRestore', 'SessionWindowStateStoreRestore [k#1]'),
      node('SessionWindowStateStoreSave', 'SessionWindowStateStoreSave [k#1]'),
      node('Scan parquet', 'FileScan parquet [a#1]'),
    ] });
    expect(writesOf(plan)).toEqual([]);
  });

  it('finds writes anywhere in the tree, per execution, in execution order', () => {
    const inner = node('Execute InsertIntoHiveTable', 'Execute InsertIntoHiveTable `a`.`b`, serde, false, false, [x]');
    const report = extractWriteTargets(new Map([
      [7, { id: 7, planTree: node('AdaptiveSparkPlan', 'AdaptiveSparkPlan', { children: [inner] }) }],
      [2, { id: 2, planTree: node('Execute InsertIntoHadoopFsRelationCommand', 'Execute InsertIntoHadoopFsRelationCommand /p, false, Parquet') }],
    ]));
    expect(report.writes.map((w) => [w.sqlExecutionId, w.target])).toEqual([[2, '/p'], [7, 'a.b']]);
  });

  it('reads output rows from the write node metric, null when absent', () => {
    const detail = 'Execute InsertIntoHadoopFsRelationCommand /p, false, Parquet';
    const withRows = node('Execute InsertIntoHadoopFsRelationCommand', detail, {
      metrics: [{ name: 'number of written files', value: 3 }, { name: 'number of output rows', value: 0 }],
    });
    expect(writesOf(withRows)[0].outputRows).toBe(0);
    expect(writesOf(node('Execute InsertIntoHadoopFsRelationCommand', detail))[0].outputRows).toBeNull();
    // A child's metric is not the write's.
    const childOnly = node('Execute InsertIntoHadoopFsRelationCommand', detail, {
      children: [node('Project', 'Project', { metrics: [{ name: 'number of output rows', value: 9 }] })],
    });
    expect(writesOf(childOnly)[0].outputRows).toBeNull();
  });

  it('lists executions with no plan instead of treating them as write-free', () => {
    const report = extractWriteTargets(new Map([[4, { id: 4, planTree: null }], [5, { id: 5 }]]));
    expect(report).toEqual({ writes: [], executionsWithoutPlan: [4, 5] });
  });
});

describe('evidence report writeTargets contract', () => {
  it('yields null target and null outputRows for a log lacking that data, never 0', () => {
    const model = emptyAppModel();
    model.sql.set(1, { id: 1, planTree: node('Execute SaveIntoDataSourceCommand', 'Execute SaveIntoDataSourceCommand') });
    model.sql.set(2, { id: 2, planTree: null });
    const { json } = buildEvidenceReport(model, { markdown: false });
    expect(json.writeTargets).toEqual({
      writes: [{
        sqlExecutionId: 1, nodeId: null, command: 'SaveIntoDataSourceCommand', recognized: true,
        kind: null, target: null, outputRows: null, raw: 'Execute SaveIntoDataSourceCommand',
      }],
      executionsWithoutPlan: [2],
    });
  });

  it('is empty for a run with no SQL executions', () => {
    const { json } = buildEvidenceReport(emptyAppModel(), { markdown: false });
    expect(json.writeTargets).toEqual({ writes: [], executionsWithoutPlan: [] });
  });
});
