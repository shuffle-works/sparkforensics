import { describe, it, expect } from 'vitest';
import { extractWriteTargets } from '../src/write-targets.ts';

// Plans shaped like a real Delta log: a command node is a bare leaf, and a table's path appears
// only as `<path>/_delta_log` in the scans of the executions that read its log. Ids and paths are
// synthetic.
const BASE = 'hdfs://nn/sandbox/db.db';
const node = (name, detail = name, children = []) => ({ id: 'n0', name, detail, metrics: [], children });
const logScan = (table) => node(`Scan ExistingRDD Delta Table State with Stats #0 - ${BASE}/${table}/_delta_log`,
  `Scan ExistingRDD Delta Table State with Stats #0 - ${BASE}/${table}/_delta_log[txn#1,add#2]`);
const project = () => node('Project', 'Project [id#1]');

// exec(id, fields): a root execution unless `rootExecutionId` says otherwise.
const exec = (id, fields = {}) => ({ id, rootExecutionId: id, startTime: id * 100, description: 'q', planTree: project(), ...fields });
const mergeStep = (id, planTree, fields = {}) => exec(id, { description: 'MERGE operation - scanning files for matches', planTree, ...fields });
const sqlOf = (...execs) => new Map(execs.map((e) => [e.id, e]));
const writesOf = (...execs) => extractWriteTargets(sqlOf(...execs)).writes;
const targetsOf = (writes) => writes.map(({ command, kind, target }) => ({ command, kind, target }));

const writeStep = (id, planTree = project(), fields = {}) =>
  mergeStep(id, planTree, { description: 'MERGE operation - writing new files for only inserts', ...fields });

// Eight executions of one API merge, from `first`: the write step (last) carries no path.
const apiMerge = (first, table) => Array.from({ length: 8 }, (_, k) =>
  k < 7 ? mergeStep(first + k, k < 5 ? logScan(table) : project()) : writeStep(first + k));

describe('SQL MERGE, UPDATE, DELETE and saves: target from the kept arguments line', () => {
  const withArgs = (command, args, fields = {}) => exec(1, {
    planTree: node(`Execute ${command}`), commandArguments: `${command}\nArguments: ${args}`, ...fields,
  });

  it.each([
    ['MergeIntoCommand', 'SubqueryAlias source, SubqueryAlias target, `spark_catalog`.`db`.`t_merge`, org.apache.hadoop.hive.serde2.lazy.X, Delta[version=0, ... db.db/t_merge], (id#1 = id#2)'],
    ['UpdateCommand', 'Delta[version=3, hdfs://nn/sandbox/db.db/t_merge], `spark_catalog`.`db`.`t_merge`, org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe, [id#1L, 99], (id#1L < 10)'],
    ['DeleteCommand', 'org.apache.spark.sql.delta.DeltaLog@1a2b, `spark_catalog`.`db`.`t_merge`, org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe, (id#1L < 10)'],
    ['WriteIntoDelta', 'Delta[version=3, ... db.db/t_merge], `spark_catalog`.`db`.`t_merge`, Append'],
  ])('reports %s as table db.t_merge', (command, args) => {
    expect(targetsOf(writesOf(withArgs(command, args)))).toEqual([{ command, kind: 'table', target: 'db.t_merge' }]);
  });

  it('keeps the catalog of a table outside the session catalog, and a name it was given in two parts', () => {
    expect(writesOf(withArgs('MergeIntoCommand', 'a, `cat`.`db`.`t`, b'))[0]).toMatchObject({ kind: 'table', target: 'cat.db.t' });
    expect(writesOf(withArgs('MergeIntoCommand', 'a, `db`.`t`, b'))[0]).toMatchObject({ kind: 'table', target: 'db.t' });
  });

  it('names no table when two arguments are quoted tables, one is cut, or the line is another command\'s', () => {
    expect(writesOf(withArgs('MergeIntoCommand', 'a, `db`.`s`, `db`.`t`, b'))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(withArgs('MergeIntoCommand', 'a, `db`.`t`'))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(withArgs('MergeIntoCommand', 'a, `t`, b'))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(withArgs('MergeIntoCommand', 'a, b', { commandArguments: 'UpdateCommand\nArguments: a, `db`.`t`, b' }))[0])
      .toMatchObject({ kind: null, target: null });
  });

  it('reports a Delta save by its path option, and nothing for a save the arguments do not show to be Delta', () => {
    const save = (args, fields) => withArgs('SaveIntoDataSourceCommand', args, fields);
    const delta = 'org.apache.spark.sql.delta.sources.DeltaDataSource@1a2b';
    expect(writesOf(save(`${delta}, [path=${BASE}/t_save, mergeSchema=true], Append`))[0])
      .toMatchObject({ kind: 'path', target: `${BASE}/t_save` });
    expect(writesOf(save(`${delta}, [path=a, path=b], Append`))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(save(`${delta}, [path=hdfs://nn/..., mode=x], Append`))[0]).toMatchObject({ kind: null, target: null });
    // A JDBC save whose root also reads a Delta table: that table is not its target.
    const jdbc = exec(1, { planTree: node('Execute SaveIntoDataSourceCommand') });
    expect(writesOf(jdbc, exec(2, { rootExecutionId: 1, planTree: logScan('t_read') }))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(save('org.apache.spark.sql.jdbc.JdbcRelationProvider@1, [url=x], Append', {}),
      exec(2, { rootExecutionId: 1, planTree: logScan('t_read') }))[0]).toMatchObject({ kind: null, target: null });
  });

  it('prefers the simpleString target of a command that prints one', () => {
    const update = exec(1, { planTree: node('Execute UpdateCommand', 'Execute UpdateCommand delta.`/sandbox/t6`, (id = 1)'),
      commandArguments: 'UpdateCommand\nArguments: a, `db`.`other`, b' });
    expect(writesOf(update)[0]).toMatchObject({ kind: 'path', target: '/sandbox/t6' });
  });
});

describe('SQL MERGE, UPDATE, DELETE and saves: target from the child executions', () => {
  const merge = (fields = {}) => exec(1, { planTree: node('Execute MergeIntoCommand'), ...fields });
  // A sub-query of the command, whatever the command: only a MERGE's carry a MERGE description.
  const child = (id, planTree, fields = {}) => exec(id, { description: 'Delta: DELETE operation', planTree, rootExecutionId: 1, ...fields });

  it('takes the one _delta_log path of the executions that share its root', () => {
    const writes = writesOf(merge(), child(2, logScan('t_one')), child(3, project()), child(4, logScan('t_one')));
    expect(targetsOf(writes)).toEqual([{ command: 'MergeIntoCommand', kind: 'path', target: `${BASE}/t_one` }]);
  });

  it.each([
    ['DeleteCommand'], ['UpdateCommand'],
  ])('does the same for %s', (command) => {
    const writes = writesOf(exec(1, { planTree: node(`Execute ${command}`) }), child(2, logScan('t_one')));
    expect(targetsOf(writes)).toEqual([{ command, kind: 'path', target: `${BASE}/t_one` }]);
  });

  it.each([
    ['WriteIntoDelta'], ['WriteIntoDeltaCommand'], ['SaveIntoDataSourceCommand'],
  ])('never takes the children of %s, which may read another table as its source', (command) => {
    const commandArguments = `${command}\nArguments: org.apache.spark.sql.delta.sources.DeltaDataSource@1, [mode=x], Append`;
    const writes = writesOf(exec(1, { planTree: node(`Execute ${command}`), commandArguments }), child(2, logScan('t_source')));
    expect(targetsOf(writes)).toEqual([{ command, kind: null, target: null }]);
    expect(targetsOf(writesOf(exec(1, { planTree: node(`Execute ${command}`) }), child(2, logScan('t_source')))))
      .toEqual([{ command, kind: null, target: null }]);
  });

  it('names a write that reads a Delta source by its own arguments, not by the source', () => {
    const write = exec(1, { planTree: node('Execute WriteIntoDelta'),
      commandArguments: 'WriteIntoDelta\nArguments: Delta[version=0], `spark_catalog`.`db`.`t_target`, Append' });
    expect(targetsOf(writesOf(write, child(2, logScan('t_source'))))).toEqual([{ command: 'WriteIntoDelta', kind: 'table', target: 'db.t_target' }]);
  });

  it('reports null when the children name two tables, none, a cut path, or have no plan', () => {
    expect(writesOf(merge(), child(2, logScan('t_one')), child(3, logScan('t_two')))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(merge())[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(merge(), child(2, project()))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(merge(), child(2, node('Scan State - hdfs://nn/sandbox/.../_delta_log')))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(merge(), child(2, null))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(merge(), child(2, node('Scan x', 'Scan x [a#1]  _delta_log')))[0]).toMatchObject({ kind: null, target: null });
  });

  it('never takes the children of a command that is not its own root', () => {
    const nested = exec(5, { rootExecutionId: 1, planTree: node('Execute MergeIntoCommand') });
    expect(writesOf(exec(1), nested, exec(6, { rootExecutionId: 1, planTree: logScan('t_one') }))[0])
      .toMatchObject({ kind: null, target: null });
    const noRoot = merge({ rootExecutionId: undefined });
    expect(writesOf(noRoot, child(2, logScan('t_one')))[0]).toMatchObject({ kind: null, target: null });
  });

  it('does not report the merge\'s own sub-queries as an API merge', () => {
    const writes = writesOf(merge(), ...[2, 3].map((id) => mergeStep(id, logScan('t_one'), { rootExecutionId: 1 })));
    expect(writes).toHaveLength(1);
    expect(writes[0].command).toBe('MergeIntoCommand');
  });
});

describe('DeltaTable API merges', () => {
  it('reports one DeltaMerge write per group, with the path its scan steps name', () => {
    const writes = writesOf(...apiMerge(10, 't_api'));
    expect(writes).toEqual([{
      sqlExecutionId: 10, nodeId: null, command: 'DeltaMerge', recognized: true, kind: 'path',
      target: `${BASE}/t_api`, outputRows: null, raw: 'Delta MERGE operation, executions 10-17',
    }]);
  });

  it('takes the path from a group whose write step names none', () => {
    expect(writesOf(mergeStep(16, logScan('t_api')), writeStep(17))[0]).toMatchObject({ kind: 'path', target: `${BASE}/t_api` });
  });

  it('reports one write per merge for groups separated by other executions', () => {
    const between = [exec(18), exec(19), exec(20), exec(21)];
    const writes = writesOf(...apiMerge(10, 't_one'), ...between, ...apiMerge(22, 't_two'));
    expect(targetsOf(writes)).toEqual([
      { command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_one` },
      { command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_two` },
    ]);
  });

  it('counts a sub-query rooted in another execution of the same merge as a member', () => {
    const writes = writesOf(mergeStep(14, logScan('t_api')), mergeStep(15, project(), { rootExecutionId: 14 }), writeStep(16));
    expect(writes).toHaveLength(1);
    expect(writes[0].raw).toBe('Delta MERGE operation, executions 14-16');
  });

  it('reads the Delta: prefixed descriptions too', () => {
    const writes = writesOf(exec(1, { description: 'Delta: MERGE operation - Writing modified data - MERGE operation - Rewriting 1 files', planTree: logScan('t_api') }));
    expect(writes[0]).toMatchObject({ command: 'DeltaMerge', target: `${BASE}/t_api` });
  });

  it('gives no path to two merges whose executions have consecutive ids', () => {
    const writes = writesOf(...apiMerge(10, 't_one'), ...apiMerge(18, 't_two'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: null, target: null, raw: 'Delta MERGE operation, executions 10-25' });
  });

  it('gives no path to merges that ran concurrently, whose executions interleave in time', () => {
    // Merge A's steps start at 100 and 300, merge B's at 200 and 250: B runs inside A's span.
    const a = [mergeStep(10, logScan('t_one'), { startTime: 100 }), writeStep(11, logScan('t_one'), { startTime: 300 })];
    const b = [mergeStep(20, logScan('t_two'), { startTime: 200 }), writeStep(21, logScan('t_two'), { startTime: 250 })];
    const writes = writesOf(...a, ...b);
    expect(writes.map(({ kind, target, raw }) => ({ kind, target, raw }))).toEqual([
      { kind: null, target: null, raw: 'Delta MERGE operation, executions 10-11 (overlaps another merge in time)' },
      { kind: null, target: null, raw: 'Delta MERGE operation, executions 20-21 (overlaps another merge in time)' },
    ]);
  });

  it('gives no path to a run that only scanned, whose one path may be the merge source', () => {
    expect(writesOf(mergeStep(10, logScan('t_source')), mergeStep(11, project()))[0]).toMatchObject({
      kind: null, target: null, raw: 'Delta MERGE operation, executions 10-11 (no write phase)',
    });
  });

  it('gives no path to threaded phases split into singleton groups, a source-only phase among them', () => {
    // Other threads' ids fall between this merge's phases: every group is a singleton whose
    // start-time span is a point, so none overlaps another. Only the write phase names a target.
    const phases = [
      mergeStep(10, logScan('t_source'), { description: 'Delta: MERGE operation - scanning files for matches: Compute snapshot' }),
      mergeStep(12, logScan('t_source')),
      writeStep(14, logScan('t_target')),
    ];
    expect(targetsOf(writesOf(...phases, exec(11), exec(13)))).toEqual([
      { command: 'DeltaMerge', kind: null, target: null },
      { command: 'DeltaMerge', kind: null, target: null },
      { command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_target` },
    ]);
  });

  it('reads a rewrite phase as a write phase', () => {
    const rewrite = mergeStep(10, logScan('t_api'), { description: 'MERGE operation - Rewriting 1 files' });
    expect(targetsOf(writesOf(rewrite))).toEqual([{ command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_api` }]);
  });

  it('gives no path to one run holding interleaved steps of two merges', () => {
    // Even/odd ids from two threads form one consecutive run naming two tables.
    const mixed = [10, 11, 12, 13].map((id) => mergeStep(id, logScan(id % 2 ? 't_two' : 't_one')));
    expect(writesOf(...mixed)).toMatchObject([{ kind: null, target: null }]);
  });

  it('gives no path to a group with a member that has no plan, no start time, or a cut path', () => {
    expect(writesOf(mergeStep(10, logScan('t_api')), writeStep(11, null))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(writeStep(10, logScan('t_api'), { startTime: undefined }))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(writeStep(10, node('Scan State - hdfs://nn/db.db/...x/_delta_log')))[0]).toMatchObject({ kind: null, target: null });
  });

  it('does not take a path from a non-MERGE execution', () => {
    const reads = [
      exec(1, { description: 'count at NativeMethodAccessorImpl.java:0', planTree: logScan('t_read') }),
      exec(2, { description: 'Delta: Filtering files for query', planTree: logScan('t_api') }),
      exec(3, { description: '$anonfun$recordDeltaOperationInternal$1 at DatabricksLogging.scala:128', planTree: logScan('t_api') }),
      exec(4, { description: 'Delta: OPTIMIZE operation', planTree: logScan('t_api') }),
    ];
    expect(writesOf(...reads)).toEqual([]);
    // They sit next to a merge group without joining it.
    const writes = writesOf(exec(9, { planTree: logScan('t_other') }), ...apiMerge(10, 't_api'), exec(18, { planTree: logScan('t_other') }));
    expect(targetsOf(writes)).toEqual([{ command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_api` }]);
  });

  it('reports a root whose user-set description starts with MERGE operation as a merge group', () => {
    // A job description set by the user is indistinguishable from Delta's: the group is reported
    // with the one table the execution reads, and a null target when it reads none.
    expect(writesOf(exec(1, { description: 'MERGE operation (nightly) writing', planTree: logScan('t_read') }))[0])
      .toMatchObject({ command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_read` });
    expect(writesOf(exec(1, { description: 'MERGE operation (nightly)' }))[0]).toMatchObject({ command: 'DeltaMerge', kind: null, target: null });
  });

  it('reports a SQL MERGE and an API merge side by side, in execution order', () => {
    const sqlMerge = exec(1, { planTree: node('Execute MergeIntoCommand'),
      commandArguments: 'MergeIntoCommand\nArguments: a, `spark_catalog`.`db`.`t_sql`, b' });
    const writes = writesOf(...apiMerge(10, 't_api'), sqlMerge, mergeStep(2, logScan('t_sql'), { rootExecutionId: 1 }));
    expect(targetsOf(writes)).toEqual([
      { command: 'MergeIntoCommand', kind: 'table', target: 'db.t_sql' },
      { command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_api` },
    ]);
  });
});

describe('Delta appends, overwrites and CTAS of a table', () => {
  // Shapes printed by Delta 3.3.2 on Spark 3.5: the table object of an append to an existing table,
  // and the staged table of the append a CTAS or RTAS runs under its own root.
  const tableV2 = (command, { catalog = 'Catalog: spark_catalog\n', table = 'Table: t_one\n', path = 'hdfs://nn/sandbox/db.db/t_one', rest = '' } = {}) =>
    `${command} DeltaTableV2(org.apache.spark.sql.SparkSession@5a1b2c,${path},Some(CatalogTable(\n${catalog}Database: db\n${table}Owner: spark\nProvider: delta\n)),Some(db.t_one),None,Map())${rest}, Project [id#1L], org.apache.spark.sql.delta.catalog.WriteIntoDeltaBuilder$$anon$1@25dc875`;
  const staged = 'AppendDataExecV1 org.apache.spark.sql.delta.catalog.DeltaCatalog$StagedDeltaTableV2@3dee60f, Project [id#1L], org.apache.spark.sql.execution.datasources.v2.DataSourceV2Strategy$$Lambda$2233/0x0000000841505440@1a7945a4';
  const ctas = (name = 'db.t_one', command = 'AtomicCreateTableAsSelect') =>
    node(`${command}`, `${command} org.apache.spark.sql.delta.catalog.DeltaCatalog@70e14c40, ${name}, Project [id#1L], TableSpec(Map(),Some(delta),Map(),None,None,None,false), false`);
  const write = (id, command, detail, fields = {}) => exec(id, { planTree: node(command, detail), ...fields });

  it.each(['AppendDataExecV1', 'OverwriteByExpressionExecV1'])('reports %s on an existing table as table db.t', (command) => {
    expect(targetsOf(writesOf(write(1, command, tableV2(command))))).toEqual([{ command, kind: 'table', target: 'db.t_one' }]);
  });

  it('keeps a catalog other than the session catalog, and reads a table object with no Catalog line', () => {
    expect(writesOf(write(1, 'AppendDataExecV1', tableV2('AppendDataExecV1', { catalog: 'Catalog: other\n' })))[0])
      .toMatchObject({ kind: 'table', target: 'other.db.t_one' });
    expect(writesOf(write(1, 'AppendDataExecV1', tableV2('AppendDataExecV1', { catalog: '' })))[0])
      .toMatchObject({ kind: 'table', target: 'db.t_one' });
  });

  it('reports a path table by its path, and nothing for a name or path it cannot read', () => {
    const pathBased = 'AppendDataExecV1 DeltaTableV2(org.apache.spark.sql.SparkSession@5a1b2c,hdfs://nn/sandbox/db.db/t_path,None,None,None,Map()), Project [id#1L]';
    expect(writesOf(write(1, 'AppendDataExecV1', pathBased))[0]).toMatchObject({ kind: 'path', target: 'hdfs://nn/sandbox/db.db/t_path' });
    expect(writesOf(write(1, 'AppendDataExecV1', pathBased.replace('hdfs://nn/sandbox/db.db/t_path', 'hdfs://nn/.../t_path')))[0])
      .toMatchObject({ kind: null, target: null });
    expect(writesOf(write(1, 'AppendDataExecV1', tableV2('AppendDataExecV1', { table: 'Table: my table\n' })))[0])
      .toMatchObject({ kind: null, target: null });
    expect(writesOf(write(1, 'AppendDataExecV1', tableV2('AppendDataExecV1').replace('Database: db\n', '')))[0])
      .toMatchObject({ kind: null, target: null });
  });

  it('still reads a V2 write object that names its table', () => {
    expect(writesOf(write(1, 'AppendData', 'AppendData IcebergWrite(table=cat.db.events, format=PARQUET)'))[0])
      .toMatchObject({ kind: 'table', target: 'cat.db.events' });
  });

  it.each(['AtomicCreateTableAsSelect', 'AtomicReplaceTableAsSelect'])('gives the staged append of a %s the table its root names', (command) => {
    const writes = writesOf(exec(1, { planTree: ctas('db.t_one', command) }), write(2, 'AppendDataExecV1', staged, { rootExecutionId: 1 }));
    expect(writes.map(({ sqlExecutionId, command: c, kind, target }) => [sqlExecutionId, c, kind, target])).toEqual([
      [1, command, 'unqualifiedTable', 'db.t_one'],
      [2, 'AppendDataExecV1', 'unqualifiedTable', 'db.t_one'],
    ]);
  });

  it('leaves a staged append with no single named CTAS root unattributed', () => {
    const append = (fields) => write(2, 'AppendDataExecV1', staged, fields);
    expect(writesOf(append({ rootExecutionId: 2 }))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(append({ rootExecutionId: undefined }))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(append({ rootExecutionId: 1 }))[0]).toMatchObject({ kind: null, target: null });
    expect(writesOf(exec(1, { planTree: ctas('t_bare', 'AtomicCreateTableAsSelect') }), append({ rootExecutionId: 1 }))[1])
      .toMatchObject({ kind: 'unqualifiedTable', target: 't_bare' });
    expect(writesOf(exec(1, { planTree: node('Execute Other', 'Execute Other', [ctas('db.a'), ctas('db.b')]) }), append({ rootExecutionId: 1 }))
      .find((w) => w.command === 'AppendDataExecV1')).toMatchObject({ kind: null, target: null });
    expect(writesOf(exec(1, { planTree: ctas('db.t_one', 'AtomicCreateTableAsSelect') }), write(2, 'AppendDataExecV1', 'AppendDataExecV1 Other@1, x', { rootExecutionId: 1 }))[1])
      .toMatchObject({ kind: null, target: null });
  });
});
