import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRun, emptyAppModel, nodeFileFromPath } from '../src/cli/collect-run.ts';
import { nodeParseCodecs } from '../src/cli/native-zstd.ts';
import { createState, runParse } from '../src/parser-worker.ts';
import { createModelCallbacks } from '../src/model-assembler.ts';
import { routeMessage } from '../src/ingest.ts';
import { buildEvidenceReport } from '../src/evidence-report.ts';
import { captureSnapshot, applySnapshot } from '../src/session-snapshot.ts';

// The dashboard assembles its model from the worker's messages with createModelCallbacks (see
// src/store/useIngest.ts); the CLI, MCP and SHS paths go through collectRun. Both must end with the
// same model-level parse gaps, so the dashboard's JSON export and the CLI report the same writeTargets.
const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-ingest-parity-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const START = 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart';
const END = 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd';

function logWithUnreadableStarts() {
  let deep = { nodeName: 'Execute InsertIntoHadoopFsRelationCommand', simpleString: 'Execute InsertIntoHadoopFsRelationCommand /prod/t, false, Parquet', children: [], metrics: [] };
  for (let i = 0; i < 600; i++) deep = { nodeName: 'Project', simpleString: 'Project', children: [deep], metrics: [] };
  const ok = { nodeName: 'Execute InsertIntoHadoopFsRelationCommand', simpleString: 'Execute InsertIntoHadoopFsRelationCommand /sandbox/out, false, Parquet', children: [], metrics: [] };
  const cutOff = JSON.stringify({ Event: START, executionId: 3, time: 3, sparkPlanInfo: ok });
  const path = join(dir, 'eventlog');
  writeFileSync(path, [
    '{"Event":"SparkListenerApplicationStart","App ID":"app-parity","App Name":"t","Timestamp":0}',
    JSON.stringify({ Event: START, executionId: 1, time: 1, sparkPlanInfo: deep }),
    JSON.stringify({ Event: START, executionId: 2, time: 2, sparkPlanInfo: ok }),
    JSON.stringify({ Event: END, executionId: 2, time: 9 }),
    cutOff.slice(0, cutOff.length - 40),
  ].join('\n'));
  return path;
}

// The dashboard's wiring: worker messages -> routeMessage -> createModelCallbacks, nothing else.
async function ingestLikeTheDashboard(path) {
  const appModel = emptyAppModel();
  const callbacks = createModelCallbacks(appModel, { onProgress() {}, onDone() {}, onError() {} });
  const file = nodeFileFromPath(path);
  try {
    await runParse(file, createState(), { emit: (msg) => routeMessage(msg, callbacks), ...nodeParseCodecs });
  } finally {
    file.close();
  }
  return appModel;
}

describe('write targets agree across ingest paths', () => {
  it('reports the same writeTargets from the dashboard ingest and from the CLI ingest', async () => {
    const path = logWithUnreadableStarts();
    const dashboard = await ingestLikeTheDashboard(path);
    const { appModel: cli } = await collectRun(path);
    const dashboardTargets = buildEvidenceReport(dashboard, { markdown: false }).json.writeTargets;
    const cliTargets = buildEvidenceReport(cli, { markdown: false }).json.writeTargets;

    expect(cliTargets.skippedLines).toBe(2);
    expect(cliTargets.executionsWithoutPlan).toEqual([
      { sqlExecutionId: 1, reason: 'unreadableStart' },
      { sqlExecutionId: 3, reason: 'unreadableStart' },
    ]);
    expect(cliTargets.writes.map((w) => w.target)).toEqual(['/sandbox/out']);
    expect(dashboardTargets).toEqual(cliTargets);
  });

  it('keeps the parse gaps through a session snapshot round trip', async () => {
    const dashboard = await ingestLikeTheDashboard(logWithUnreadableStarts());
    const before = buildEvidenceReport(dashboard, { markdown: false }).json.writeTargets;
    const snapshot = captureSnapshot(dashboard, [], new Map());
    const restored = emptyAppModel();
    applySnapshot(restored, new Map(), snapshot);
    expect(buildEvidenceReport(restored, { markdown: false }).json.writeTargets).toEqual(before);
    expect(before.skippedLines).toBe(2);
  });

  it('does not leave a previous run\'s gaps on a model that finishes clean', () => {
    const appModel = emptyAppModel();
    const callbacks = createModelCallbacks(appModel, {});
    callbacks.onDone({ skippedLines: 2, unreadableSqlExecutions: [1] });
    callbacks.onDone({ skippedLines: 0 });
    expect(appModel.skippedLines).toBe(0);
    expect(appModel.unreadableSqlExecutions).toBeUndefined();
  });
});

// Synthetic log shaped like a real Delta run: bare command leaves, a SQL MERGE with sub-queries under
// its root, two DeltaTable API merges of independent root executions, and reads that name a
// _delta_log without writing.
const DELTA_LOG = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'delta-write-events.ndjson');
const BASE = 'hdfs://nn/sandbox/db.db';

describe('Delta write targets from a log', () => {
  const expectedWrites = [
    { sqlExecutionId: 3, command: 'MergeIntoCommand', kind: 'table', target: 'db.t_sql_merge' },
    { sqlExecutionId: 10, command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_api_one` },
    { sqlExecutionId: 22, command: 'DeltaMerge', kind: 'path', target: `${BASE}/t_api_two` },
    { sqlExecutionId: 40, command: 'UpdateCommand', kind: 'table', target: 'db.t_update' },
    { sqlExecutionId: 41, command: 'DeleteCommand', kind: 'table', target: 'db.t_delete' },
    // DeltaTable API merges: a command root with sub-queries of two threads interleaved.
    { sqlExecutionId: 50, command: 'MergeIntoCommand', kind: 'table', target: 'db.t_cmd_one' },
    { sqlExecutionId: 52, command: 'MergeIntoCommand', kind: 'table', target: 'db.t_cmd_two' },
  ];

  it('reports the same targets from the dashboard ingest and from the CLI ingest', async () => {
    const dashboard = await ingestLikeTheDashboard(DELTA_LOG);
    const { appModel: cli } = await collectRun(DELTA_LOG);
    const dashboardTargets = buildEvidenceReport(dashboard, { markdown: false }).json.writeTargets;
    const cliTargets = buildEvidenceReport(cli, { markdown: false }).json.writeTargets;
    expect(cliTargets.writes.map(({ sqlExecutionId, command, kind, target }) => ({ sqlExecutionId, command, kind, target })))
      .toEqual(expectedWrites);
    expect(cliTargets.executionsWithoutPlan).toEqual([]);
    expect(dashboardTargets).toEqual(cliTargets);
  });

  it('keeps the targets through a session snapshot round trip', async () => {
    const dashboard = await ingestLikeTheDashboard(DELTA_LOG);
    const before = buildEvidenceReport(dashboard, { markdown: false }).json.writeTargets;
    const restored = emptyAppModel();
    applySnapshot(restored, new Map(), captureSnapshot(dashboard, [], new Map()));
    expect(buildEvidenceReport(restored, { markdown: false }).json.writeTargets).toEqual(before);
  });
});
