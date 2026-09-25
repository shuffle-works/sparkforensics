import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRun, dispatch } from '../src/cli/collect-run.js';

function tmpFile(contents, name = 'eventlog') {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-cli-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return { dir, path };
}

describe('collectRun', () => {
  it('parses a single event-log file into an appModel', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"t","Timestamp":1}\n'
      + '{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n';
    const { dir, path } = tmpFile(ndjson);
    try {
      const { appModel, skippedLines } = await collectRun(path);
      expect(appModel.app.id).toBe('app-1');
      expect(appModel.app.endTime).toBe(2);
      expect(skippedLines).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects with the parser error message for a non-Spark file', async () => {
    const { dir, path } = tmpFile('not an event log\n');
    try {
      await expect(collectRun(path)).rejects.toThrow(/Not a Spark event log/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects with a clear message for an empty file', async () => {
    const { dir, path } = tmpFile('');
    try {
      await expect(collectRun(path)).rejects.toThrow(/File is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a rolling-log directory in reassembled order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-cli-dir-'));
    writeFileSync(join(dir, 'events_2_app-1'), '{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n');
    writeFileSync(join(dir, 'events_1_app-1'), '{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"t","Timestamp":1}\n');
    try {
      const { appModel } = await collectRun(dir);
      expect(appModel.app.id).toBe('app-1');
      expect(appModel.app.endTime).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a directory with no rolling event-log files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-cli-empty-'));
    writeFileSync(join(dir, 'readme.txt'), 'not a log');
    try {
      await expect(collectRun(dir)).rejects.toThrow(/rolling event-log directory/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Pins dispatch()'s per-message-type wiring to src/ingest.js's routeMessage.
describe('dispatch', () => {
  const dataTypes = [
    ['app', 'onApp'],
    ['stage', 'onStage'],
    ['sql', 'onSql'],
    ['sqlPlan', 'onSqlPlan'],
    ['executor', 'onExecutor'],
    ['job', 'onJob'],
    ['runAggregates', 'onRunAggregates'],
    ['stageExecutorMetrics', 'onStageExecutorMetrics'],
    ['stageSpeculationWaste', 'onStageSpeculationWaste'],
  ];

  it.each(dataTypes)('routes a %s message\'s data to %s', (type, handlerName) => {
    const handlers = { [handlerName]: vi.fn() };
    const payload = { id: 'x' };
    dispatch({ type, data: payload }, handlers);
    expect(handlers[handlerName]).toHaveBeenCalledWith(payload);
  });

  it('routes a done message to onDone, narrowed to skippedLines only', () => {
    const handlers = { onDone: vi.fn() };
    const msg = { type: 'done', skippedLines: 3, extraField: 'should be dropped' };
    dispatch(msg, handlers);
    expect(handlers.onDone).toHaveBeenCalledWith({ skippedLines: 3 });
  });

  it('routes an error message to onError', () => {
    const handlers = { onError: vi.fn() };
    const msg = { type: 'error', message: 'boom' };
    dispatch(msg, handlers);
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });

  it('does not throw on a progress or taskData message with no matching handler', () => {
    expect(() => dispatch({ type: 'progress' }, {})).not.toThrow();
    expect(() => dispatch({ type: 'taskData', reqId: '0' }, {})).not.toThrow();
  });
});
