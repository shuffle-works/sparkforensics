import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, openSync, writeSync, closeSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { zipSync } from '../src/vendor/fflate.js';
import { collectRun, dispatch, emptyAppModel, nodeFileFromPath } from '../src/cli/collect-run.js';
import { createState, runParse } from '../src/parser-worker.js';
import { createModelCallbacks } from '../src/model-assembler.js';

// Pass-through spies, so tests can count descriptor opens against closes.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync) };
});

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

// A real, public event log (the landing page's bundled sample run), about 1.6 MB
// uncompressed: streamFile reads it in ~100 slices, so lines straddle slice boundaries.
const sampleNdjson = gunzipSync(readFileSync(fileURLToPath(new URL('../../../public/sample-runs/sample-run.ndjson.gz', import.meta.url))));

// The same log parsed from an in-memory Blob, the shape the browser hands the parser.
async function parseInMemory(bytes) {
  const appModel = emptyAppModel();
  const cb = createModelCallbacks(appModel, { onProgress() {}, onDone() {}, onError() {} });
  await runParse(new Blob([bytes]), createState(), { emit: (msg) => dispatch(msg, cb) });
  return appModel;
}

describe('nodeFileFromPath', () => {
  afterEach(() => {
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.closeSync).mockClear();
  });

  it('reads byte ranges, clamping past the end, and closes once a read reaches the end', async () => {
    const bytes = new Uint8Array(4096).map((_, i) => i % 251);
    const { dir, path } = tmpFile(bytes);
    try {
      const file = nodeFileFromPath(path);
      expect(file.size).toBe(4096);
      expect(new Uint8Array(await file.slice(0, 10).arrayBuffer())).toEqual(bytes.subarray(0, 10));
      expect(new Uint8Array(await file.slice(1000, 3000).arrayBuffer())).toEqual(bytes.subarray(1000, 3000));
      expect(fs.closeSync).not.toHaveBeenCalled();
      expect(new Uint8Array(await file.slice(4000, 9999).arrayBuffer())).toEqual(bytes.subarray(4000));
      expect((await file.slice(5000, 6000).arrayBuffer()).byteLength).toBe(0);
      expect(fs.openSync).toHaveBeenCalledTimes(1);
      expect(fs.closeSync).toHaveBeenCalledTimes(1);
      file.close();
      expect(fs.closeSync).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a read when the file shrank after it was opened, without leaking the descriptor', async () => {
    const { dir, path } = tmpFile(new Uint8Array(1024));
    try {
      const file = nodeFileFromPath(path);
      truncateSync(path, 100);
      await expect(file.slice(0, 1024).arrayBuffer()).rejects.toThrow(/shrank/);
      expect(fs.closeSync).toHaveBeenCalledTimes(fs.openSync.mock.calls.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A sparse file costs no disk space, so this runs anywhere: before slicing, the whole-file
  // read failed here with "File size (...) is greater than 2 GiB".
  it('reads a slice past the 2 GiB mark of a larger-than-2-GiB file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-cli-big-'));
    const path = join(dir, 'eventlog');
    const offset = 2 ** 31 + 12345;
    const marker = Buffer.from('past the 2 GiB mark');
    try {
      const fd = openSync(path, 'w');
      try { writeSync(fd, marker, 0, marker.length, offset); } finally { closeSync(fd); }
      const file = nodeFileFromPath(path);
      expect(file.size).toBe(offset + marker.length);
      expect(Buffer.from(await file.slice(offset, file.size).arrayBuffer()).toString()).toBe(marker.toString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectRun streaming', () => {
  afterEach(() => {
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.closeSync).mockClear();
  });

  const encodings = [
    ['uncompressed', (b) => b],
    ['gzip', (b) => gzipSync(b)],
    ['zstd', (b) => zstdCompressSync(b)],
    ['a History Server zip', (b) => zipSync({ eventlog: new Uint8Array(b) })],
  ];

  it.each(encodings)('reads %s input slice by slice and matches an in-memory parse', async (_label, encode) => {
    const expected = await parseInMemory(sampleNdjson);
    const { dir, path } = tmpFile(encode(sampleNdjson));
    try {
      const { appModel } = await collectRun(path);
      expect(appModel.app).toEqual(expected.app);
      expect([...appModel.stages.keys()]).toEqual([...expected.stages.keys()]);
      expect(appModel.sql.size).toBe(expected.sql.size);
      expect(fs.openSync.mock.calls.length).toBeGreaterThan(0);
      expect(fs.closeSync).toHaveBeenCalledTimes(fs.openSync.mock.calls.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a rolling directory split mid-line and closes every part', async () => {
    const expected = await parseInMemory(sampleNdjson);
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-cli-rolling-'));
    const third = Math.floor(sampleNdjson.length / 3);
    writeFileSync(join(dir, 'events_1_app'), sampleNdjson.subarray(0, third));
    writeFileSync(join(dir, 'events_2_app'), sampleNdjson.subarray(third, 2 * third));
    writeFileSync(join(dir, 'events_3_app'), sampleNdjson.subarray(2 * third));
    try {
      const { appModel } = await collectRun(dir);
      expect([...appModel.stages.keys()]).toEqual([...expected.stages.keys()]);
      expect(fs.closeSync).toHaveBeenCalledTimes(fs.openSync.mock.calls.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the descriptor when decompression fails partway through', async () => {
    const zst = zstdCompressSync(sampleNdjson);
    const corrupt = Buffer.concat([zst.subarray(0, Math.floor(zst.length / 2)), Buffer.alloc(4096, 0xff)]);
    const { dir, path } = tmpFile(corrupt);
    try {
      await expect(collectRun(path)).rejects.toThrow();
      expect(fs.openSync.mock.calls.length).toBeGreaterThan(0);
      expect(fs.closeSync).toHaveBeenCalledTimes(fs.openSync.mock.calls.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the descriptor when the file is not an event log', async () => {
    const { dir, path } = tmpFile('not an event log\n'.repeat(1000));
    try {
      await expect(collectRun(path)).rejects.toThrow(/Not a Spark event log/);
      expect(fs.closeSync).toHaveBeenCalledTimes(fs.openSync.mock.calls.length);
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
