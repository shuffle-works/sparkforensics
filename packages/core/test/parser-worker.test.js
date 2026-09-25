import { describe, it, expect, vi, beforeAll } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { stripPlanDescription, emitParseCompletion, parseTaskEnd } from '../src/event-handlers.ts';
import { computeTaskActiveMs, computePeakConcurrentTasks, computeTailReplayRecoveryMs } from '../src/stage-quantiles.ts';
import { buildChunkDecoder, createState, processEvent, dispatchLine, runParse, runParseFromUrl, runParseFiles, naturalCompare, reassembleRollingEntries, sniffCodec, parseSparkMemoryMB, FIELDS, TASK_FIELD_NAMES, computeDurationQuantiles, computeFieldQuantiles, classifySpill, collectStageExecutorMetrics, decodeShsArchive } from '../src/parser-worker.js';
import { createModelCallbacks } from '../src/model-assembler.ts';
import { routeMessage } from '../src/ingest.ts';
import { listZipEntries } from '../src/zip-archive.ts';
import { historyServerZip } from '../../../tests/helpers/shs-fixtures.js';
import { zipSync, gzipSync, strToU8 } from '../src/vendor/fflate.js';
import { zstdCompressSync, zstdDecompressSync, gunzipSync } from 'node:zlib';
import { existsSync, createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Compress NDJSON to a Zstandard frame with Node's built-in codec, then decode
// it back through the vendored fzstd in the parser: a cross-implementation
// check that mirrors real SHS logs written with spark.io.compression.codec=zstd.
const zstdSync = (u8) => new Uint8Array(zstdCompressSync(u8));

const enc = new TextEncoder();

describe('buildChunkDecoder', () => {
  // Pass the Uint8Array from enc.encode directly: the byte-scan reads
  // .indexOf/.subarray, which a bare ArrayBuffer does not expose.
  it('returns complete lines from a single chunk', () => {
    const dec = buildChunkDecoder();
    const lines = dec.decode(enc.encode('{"a":1}\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('buffers an incomplete line across two chunks', () => {
    const dec = buildChunkDecoder();
    const lines1 = dec.decode(enc.encode('{"a":'));
    expect(lines1).toEqual([]);
    const lines2 = dec.decode(enc.encode('1}\n'));
    expect(lines2).toEqual(['{"a":1}']);
  });

  it('flush returns final line without trailing newline', () => {
    const dec = buildChunkDecoder();
    dec.decode(enc.encode('{"a":1}\n{"b":2}'));
    expect(dec.flush()).toEqual(['{"b":2}']);
  });

  it('flush returns empty array when nothing pending', () => {
    const dec = buildChunkDecoder();
    dec.decode(enc.encode('{"a":1}\n'));
    expect(dec.flush()).toEqual([]);
  });

  // A multibyte char split across the boundary must be reassembled from raw
  // bytes; decoding the tail alone emits a replacement char. '€' is E2 82 AC.
  it('reassembles a UTF-8 character split across two chunks', () => {
    const dec = buildChunkDecoder();
    const full = enc.encode('{"x":"€"}\n');
    const splitAt = full.indexOf(0xac); // last byte of '€'
    expect(dec.decode(full.subarray(0, splitAt))).toEqual([]);
    expect(dec.decode(full.subarray(splitAt))).toEqual(['{"x":"€"}']);
  });

  it('drops empty lines between records', () => {
    const dec = buildChunkDecoder();
    expect(dec.decode(enc.encode('{"a":1}\n\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  // A chunk containing a multibyte char is not 1:1 byte<->char, so the decoder
  // takes its unit-counting path; a 4-byte astral char ('🚀' F0 9F 9A 80) is a
  // surrogate pair (2 UTF-16 units) and must not shift the following line.
  it('maps char offsets past 2/3/4-byte chars within one chunk', () => {
    const dec = buildChunkDecoder();
    expect(dec.decode(enc.encode('{"a":"café €"}\n{"b":"🚀 你好"}\n{"c":1}\n'))).toEqual([
      '{"a":"café €"}',
      '{"b":"🚀 你好"}',
      '{"c":1}',
    ]);
  });

  // A char split across the boundary is completed at the start of the next
  // chunk; lines that follow it in that chunk must still be cut correctly.
  it('keeps offsets correct after a boundary-completed char', () => {
    const dec = buildChunkDecoder();
    const full = enc.encode('{"x":"€"}\n{"y":2}\n');
    const splitAt = full.indexOf(0xac); // split '€' (E2 82 AC) as 2 + 1
    expect(dec.decode(full.subarray(0, splitAt))).toEqual([]);
    expect(dec.decode(full.subarray(splitAt))).toEqual(['{"x":"€"}', '{"y":2}']);
  });

  // Every chunking of the same bytes, down to one byte at a time (splitting every multibyte char
  // and every newline), yields exactly the lines of a whole-text split.
  it('yields the same lines for any chunk size, including 1-byte chunks through multibyte chars', () => {
    const text = '{"a":"café"}\n\n{"b":"€ 你好 🚀"}\n{"c":"' + 'x'.repeat(300) + '"}\n{"d":"ñ"}';
    const bytes = enc.encode(text);
    const expected = text.split('\n').filter((l) => l.length > 0);
    for (const size of [1, 2, 3, 5, 7, 64, bytes.length]) {
      const dec = buildChunkDecoder();
      const got = [];
      for (let o = 0; o < bytes.length; o += size) got.push(...dec.decode(bytes.subarray(o, o + size)));
      got.push(...dec.flush());
      expect(got).toEqual(expected);
    }
  });

  // A plan-description value still open at a chunk's end is dropped as undecoded bytes; the result
  // must match the text-level stripPlanDescription however the bytes are cut: backslash runs and
  // escaped quotes split across chunks, the prefix or key split, and an unterminated value ending
  // its line.
  it('skips a chunk-spanning physicalPlanDescription value, matching stripPlanDescription for any cut', () => {
    const alphabet = ['\\', '"', 'a', '€', '\n', ' ', '🚀'];
    let seed = 7;
    const rand = (k) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % k; };
    const planText = () => Array.from({ length: 40 }, () => alphabet[rand(alphabet.length)]).join('');
    const start = (id) => `{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart","executionId":${id},"description":"q \\"x\\" €","physicalPlanDescription":${JSON.stringify(planText())},"sparkPlanInfo":{"nodeName":"N","simpleString":"a\\\\"},"time":1}`;
    const update = (id) => `{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate","executionId":${id},"physicalPlanDescription":${JSON.stringify(planText() + '\\')},"sparkPlanInfo":{"nodeName":"M"}}`;
    const unterminated = '{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate","executionId":9,"physicalPlanDescription":"cut \\" off';
    const lines = [start(1), '{"Event":"SparkListenerJobEnd","physicalPlanDescription":"kept"}', update(1), unterminated, update(2), start(2)];
    const text = lines.join('\n') + '\n';
    const bytes = enc.encode(text);
    const expected = lines.map(stripPlanDescription);
    // The unterminated line (index 3) may come out whole or emptied; either way JSON.parse rejects it.
    const terminated = (all) => all.filter((_, i) => i !== 3);
    const decodeInChunks = (cuts) => {
      const dec = buildChunkDecoder();
      const got = [];
      let from = 0;
      for (const cut of [...cuts, bytes.length]) { got.push(...dec.decode(bytes.subarray(from, cut))); from = cut; }
      got.push(...dec.flush());
      expect(got).toHaveLength(lines.length);
      expect(() => JSON.parse(got[3])).toThrow();
      return got;
    };
    for (const size of [1, 2, 3, 5, 7, 13, 64, 200]) {
      const cuts = [];
      for (let o = size; o < bytes.length; o += size) cuts.push(o);
      expect(terminated(decodeInChunks(cuts).map(stripPlanDescription))).toEqual(terminated(expected));
    }
    // Two chunks cut at every offset, so a cut lands inside every backslash run and escaped quote.
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(terminated(decodeInChunks([cut]).map(stripPlanDescription))).toEqual(terminated(expected));
    }
    // A cut just past line 2's key: its value is dropped by the decoder itself, not the text strip.
    const keyEnd = text.indexOf('"physicalPlanDescription":"', text.indexOf(lines[2])) + '"physicalPlanDescription":"'.length;
    expect(decodeInChunks([enc.encode(text.slice(0, keyEnd)).length + 3])[2]).toBe(expected[2]);
  });

  // A SQL event line without the plan key is searched for it once in all: searching the whole
  // pending line again after every slice scanned about 10 GB on a 100 MB line.
  it('searches a long SQL event line for the plan key only in text it has not searched yet', () => {
    const line = `{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart","executionId":1,"description":"${'x'.repeat(4 << 20)}","time":1}`;
    const bytes = enc.encode(`${line}\n`);
    const key = '"physicalPlanDescription":"';
    const indexOf = String.prototype.indexOf;
    let searched = 0;
    String.prototype.indexOf = function (search, from) {
      if (search === key) searched += this.length - (from ?? 0);
      return indexOf.call(this, search, from);
    };
    const dec = buildChunkDecoder();
    const got = [];
    try {
      for (let o = 0; o < bytes.length; o += 64 * 1024) got.push(...dec.decode(bytes.subarray(o, o + 64 * 1024)));
    } finally {
      String.prototype.indexOf = indexOf;
    }
    expect(got).toEqual([line]);
    expect(searched).toBeLessThan(2 * line.length);
  });

  // Node's native zstd emits whole frames (tens of MB), so a single chunk can hold a whole plan
  // description: the decoder slices it and drops the value itself. The first line puts a '€'
  // across the first 512 KiB slice boundary.
  it('drops a plan description inside one chunk larger than a decode slice', () => {
    const filler = `{"Event":"SparkListenerJobEnd","x":"${'€'.repeat(180000)}"}`;
    const plan = `{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart","executionId":1,"physicalPlanDescription":${JSON.stringify('Scan \\ "t" '.repeat(100000))},"sparkPlanInfo":{"nodeName":"N"},"time":1}`;
    const dec = buildChunkDecoder();
    const got = [...dec.decode(enc.encode(`${filler}\n${plan}\n`)), ...dec.flush()];
    expect(got).toEqual([filler, stripPlanDescription(plan)]);
  });
});

describe('createState', () => {
  it('returns a fresh state object', () => {
    const s = createState();
    expect(s.app).toBeNull();
    expect(s.pendingSparkVersion).toBeNull();
    expect(s.stages.size).toBe(0);
    expect(s.taskStore.size).toBe(0);
    expect(s.skippedLines).toBe(0);
  });

  it('starts each compact evidence input counter at zero', () => {
    expect(createState().evidenceInputs).toEqual({
      environmentUpdates: 0,
      applicationEnds: 0,
      stageSubmissions: 0,
      rddStorageSnapshots: 0,
      sqlExecutions: 0,
      resolvedSqlPlans: 0,
      executorMetricRows: 0,
      taskRecords: 0,
    });
  });
});

describe('processEvent: ApplicationStart', () => {
  it('populates state.app and returns app message', () => {
    const s = createState();
    const msg = processEvent({
      Event: 'SparkListenerApplicationStart',
      'App ID': 'application_123_1',
      'App Name': 'test-app',
      'Timestamp': 1000,
      'Spark Version': '3.4.0',
    }, s);
    expect(s.app).toMatchObject({ id: 'application_123_1', name: 'test-app', startTime: 1000, endTime: null, sparkVersion: '3.4.0', config: {} });
    expect(s.app.resources.executor.memoryMB).toBeNull();
    expect(msg).toEqual({ type: 'app', data: s.app });
  });
});

describe('processEvent: LogStart', () => {
  it('stores Spark version and uses it in ApplicationStart', () => {
    const s = createState();
    const logMsg = processEvent({ Event: 'SparkListenerLogStart', 'Spark Version': '3.5.3' }, s);
    expect(logMsg).toBeNull();
    expect(s.pendingSparkVersion).toBe('3.5.3');

    const appMsg = processEvent({
      Event: 'SparkListenerApplicationStart',
      'App ID': 'app_1',
      'App Name': 'my-app',
      'Timestamp': 2000,
    }, s);
    expect(appMsg.data.sparkVersion).toBe('3.5.3');
  });

  it('ApplicationStart Spark Version field is used when LogStart is absent', () => {
    const s = createState();
    const appMsg = processEvent({
      Event: 'SparkListenerApplicationStart',
      'App ID': 'app_2',
      'App Name': 'my-app',
      'Timestamp': 3000,
      'Spark Version': '3.4.1',
    }, s);
    expect(appMsg.data.sparkVersion).toBe('3.4.1');
  });

  it('LogStart version takes precedence over ApplicationStart version', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerLogStart', 'Spark Version': '3.5.3' }, s);
    const appMsg = processEvent({
      Event: 'SparkListenerApplicationStart',
      'App ID': 'app_3',
      'App Name': 'my-app',
      'Timestamp': 4000,
      'Spark Version': '3.4.0',
    }, s);
    expect(appMsg.data.sparkVersion).toBe('3.5.3');
  });
});

describe('processEvent: ApplicationEnd', () => {
  it('updates endTime and returns app message', () => {
    const s = createState();
    processEvent({
      Event: 'SparkListenerApplicationStart',
      'App ID': 'app_e2e',
      'App Name': 'end-test',
      'Timestamp': 1000,
    }, s);
    const msg = processEvent({ Event: 'SparkListenerApplicationEnd', 'Timestamp': 9999 }, s);
    expect(msg).not.toBeNull();
    expect(msg.type).toBe('app');
    expect(msg.data.endTime).toBe(9999);
    expect(s.app.endTime).toBe(9999);
  });

  it('returns null when app is not yet set', () => {
    const s = createState();
    const msg = processEvent({ Event: 'SparkListenerApplicationEnd', 'Timestamp': 9999 }, s);
    expect(msg).toBeNull();
  });

  it('posts compact evidence inputs without raw configuration or event payloads', () => {
    const state = createState();
    processEvent({ Event: 'SparkListenerEnvironmentUpdate', 'Spark Properties': { 'spark.eventLog.logStageExecutorMetrics': 'false' } }, state);
    processEvent({ Event: 'SparkListenerApplicationStart', 'App ID': 'a', 'App Name': 'a', Timestamp: 1 }, state);
    const end = processEvent({ Event: 'SparkListenerApplicationEnd', Timestamp: 5 }, state);

    expect(end.data.evidenceInputs).toEqual({
      environmentUpdates: 1,
      applicationEnds: 1,
      stageSubmissions: 0,
      rddStorageSnapshots: 0,
      sqlExecutions: 0,
      resolvedSqlPlans: 0,
      executorMetricRows: 0,
      taskRecords: 0,
    });
    expect(end.data.evidenceInputs).not.toHaveProperty('config');
    expect(end.data.evidenceInputs).not.toHaveProperty('Spark Properties');
  });
});

describe('processEvent: StageSubmitted', () => {
  it('creates a stage entry and a task buffer', () => {
    const s = createState();
    const msg = processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 5, 'Stage Name': 'count', 'Details': 'details', 'Submission Time': 2000 },
    }, s);
    expect(msg).toBeNull();
    expect(s.stages.has(5)).toBe(true);
    expect(s.stages.get(5).submittedAt).toBe(2000);
    expect(s.stages.get(5).taskAttempts.size).toBe(0);
  });

  it('counts every observed evidence source without retaining the source rows', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerEnvironmentUpdate', 'Spark Properties': {} }, s);
    processEvent({ Event: 'SparkListenerApplicationStart', 'App ID': 'a', 'App Name': 'a', Timestamp: 0 }, s);
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': {
      'Stage ID': 1, 'Submission Time': 0,
      'RDD Info': [{ 'RDD ID': 7, 'Storage Level': {} }],
    } }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Task Info': { Index: 0, 'Launch Time': 0, 'Finish Time': 1 }, 'Task Metrics': {} }, s);
    processEvent({ Event: 'SparkListenerStageExecutorMetrics', 'Stage ID': 1, 'Executor ID': 'e1', 'Executor Metrics': { JVMHeapMemory: 1 } }, s);
    processEvent({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart', executionId: 9, time: 0, sparkPlanInfo: { nodeName: 'Scan', simpleString: 'Scan', children: [], metrics: [] } }, s);
    processEvent({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd', executionId: 9, time: 1 }, s);
    processEvent({ Event: 'SparkListenerApplicationEnd', Timestamp: 2 }, s);

    expect(s.evidenceInputs).toEqual({
      environmentUpdates: 1,
      applicationEnds: 1,
      stageSubmissions: 1,
      rddStorageSnapshots: 1,
      sqlExecutions: 1,
      resolvedSqlPlans: 1,
      executorMetricRows: 1,
      taskRecords: 1,
    });
  });
});

describe('processEvent: ExecutorAdded', () => {
  it('appends to executors.added and returns executor message', () => {
    const s = createState();
    const msg = processEvent({
      Event: 'SparkListenerExecutorAdded',
      'Timestamp': 5000,
      'Executor ID': '1',
      'Executor Info': { 'Host': 'host1', 'Total Cores': 4 },
    }, s);
    expect(s.executors.added).toHaveLength(1);
    expect(msg).toEqual({ type: 'executor', data: { kind: 'added', timestamp: 5000, executorId: '1', host: 'host1', totalCores: 4, resourceProfileId: null } });
  });

  it('captures Resource Profile Id nested in Executor Info (real Spark shape)', () => {
    const s = createState();
    const msg = processEvent({
      Event: 'SparkListenerExecutorAdded',
      'Timestamp': 6000,
      'Executor ID': '2',
      'Executor Info': { 'Host': 'host2', 'Total Cores': 5, 'Resources': {}, 'Resource Profile Id': 0 },
    }, s);
    expect(msg.data.resourceProfileId).toBe(0);
  });
});

describe('processEvent: SQLExecutionStart', () => {
  it('stores sql execution and returns sql message', () => {
    const s = createState();
    const msg = processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 7,
      description: 'select ...',
      time: 3000,
      physicalPlanDescription: 'FileScan parquet ...',
    }, s);
    expect(s.sqlExecutions.has(7)).toBe(true);
    expect(msg.type).toBe('sql');
    expect(msg.data.id).toBe(7);
    // Nothing downstream reads the plan's text rendering, so it is never retained.
    expect(msg.data.physicalPlanDescription).toBeUndefined();
  });
});

describe('processEvent: JobStart links stage to SQL execution', () => {
  it('sets sqlExecutionId on stage submitted after JobStart', () => {
    const s = createState();

    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 10, description: 'test', time: 1000, physicalPlanDescription: '',
    }, s);

    processEvent({
      Event: 'SparkListenerJobStart',
      'Job ID': 5,
      'Stage IDs': [18, 19],
      Properties: { 'spark.sql.execution.id': '10' },
    }, s);

    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 18, 'Stage Name': 'save', 'Details': '', 'Submission Time': 1100 },
    }, s);
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 19, 'Stage Name': 'shuffle', 'Details': '', 'Submission Time': 1200 },
    }, s);

    expect(s.stages.get(18).sqlExecutionId).toBe(10);
    expect(s.stages.get(19).sqlExecutionId).toBe(10);
  });

  it('leaves sqlExecutionId null for stages with no SQL execution', () => {
    const s = createState();
    processEvent({
      Event: 'SparkListenerJobStart',
      'Job ID': 0,
      'Stage IDs': [0],
      Properties: {},
    }, s);
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 0, 'Stage Name': 'collect', 'Details': '', 'Submission Time': 500 },
    }, s);
    expect(s.stages.get(0).sqlExecutionId).toBeNull();
  });
});

describe('processEvent: unknown event', () => {
  // Real Spark logs carry many unmodeled event types (BlockManagerAdded,
  // TaskStart, ExecutorMetricsUpdate, ...). dispatchLine gates on
  // SparkEventSchema's known Event literals, so an Event value outside those
  // 15 types is silently ignored and never counted toward skippedLines.
  it('an unrecognized Event value is silently ignored, not counted as a skipped line', () => {
    const s = createState();
    let emitted = null;
    dispatchLine(JSON.stringify({ Event: 'SparkListenerUnknown' }), s, (msg) => { emitted = msg; });
    expect(s.skippedLines).toBe(0);
    expect(emitted).toBeNull();
  });

  // A value whose Event IS one of the 15 known literals but fails its own
  // schema (SparkListenerJobEnd requires 'Job ID') is a genuine, valuable
  // signal that a JSON-parse failure or an unmodeled event type isn't: this
  // DOES still count toward skippedLines.
  it('a known Event type that fails its own schema counts as a skipped line', () => {
    const s = createState();
    let emitted = null;
    dispatchLine(JSON.stringify({ Event: 'SparkListenerJobEnd' }), s, (msg) => { emitted = msg; });
    expect(s.skippedLines).toBe(1);
    expect(emitted).toBeNull();
  });

  // processEvent's switch is exhaustive over the validated SparkEvent union
  // (assertNever default case): handed a value outside it directly (bypassing
  // dispatchLine's schema gate), it throws rather than returning null.
  it('processEvent itself throws via assertNever for a value outside the validated SparkEvent union', () => {
    const s = createState();
    expect(() => processEvent({ Event: 'SparkListenerUnknown' }, s)).toThrow(/Unreachable case/);
  });

  // A handler bug (not malformed input) surfacing through dispatchLine's
  // try/catch is still counted toward skippedLines, but logged via
  // console.error so it's distinguishable from an ordinary bad-data skip.
  it('a handler bug during processEvent is counted as skipped but logged via console.error', () => {
    const s = createState();
    dispatchLine(JSON.stringify({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Stage Name': 'agg', 'Details': '', 'Submission Time': 100 } }), s, () => {});

    // Corrupt state to force a throw inside accumulateTask's
    // stage.taskAttempts.get(key), simulating a handler bug not bad input
    // (the TaskEnd event below is fully schema-valid).
    s.stages.get(1).taskAttempts = { get() { throw new Error('simulated handler bug'); } };

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let emitted = null;
    dispatchLine(JSON.stringify({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { Index: 0, 'Launch Time': 0, 'Finish Time': 1 }, 'Task Metrics': {} }), s, (msg) => { emitted = msg; });

    expect(s.skippedLines).toBe(1);
    expect(emitted).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('computeDurationQuantiles', () => {
  it('returns zeros for empty array', () => {
    expect(computeDurationQuantiles(new Float64Array(0))).toEqual({ p50: 0, p95: 0, max: 0 });
  });

  it('computes correct quantiles for known values', () => {
    const arr = new Float64Array(10 * FIELDS.STRIDE);
    for (let i = 0; i < 10; i++) arr[i * FIELDS.STRIDE + FIELDS.DURATION] = i + 1;
    const { p50, p95, max } = computeDurationQuantiles(arr);
    expect(p50).toBe(5);
    expect(p95).toBe(10);
    expect(max).toBe(10);
  });
});

describe('computeFieldQuantiles', () => {
  it('returns zeros for an empty array', () => {
    expect(computeFieldQuantiles(new Float64Array(0), FIELDS.SHUFFLE_READ)).toEqual({ p50: 0, p95: 0, max: 0 });
  });

  it('computes correct quantiles for a known field, single task', () => {
    const arr = new Float64Array(FIELDS.STRIDE);
    arr[FIELDS.MEM_SPILLED] = 42;
    const { p50, p95, max } = computeFieldQuantiles(arr, FIELDS.MEM_SPILLED);
    expect(p50).toBe(42);
    expect(p95).toBe(42);
    expect(max).toBe(42);
  });

  it('computes correct quantiles for a known field, multiple tasks', () => {
    const arr = new Float64Array(10 * FIELDS.STRIDE);
    for (let i = 0; i < 10; i++) arr[i * FIELDS.STRIDE + FIELDS.SHUFFLE_READ] = (i + 1) * 100;
    const { p50, p95, max } = computeFieldQuantiles(arr, FIELDS.SHUFFLE_READ);
    expect(p50).toBe(500);
    expect(p95).toBe(1000);
    expect(max).toBe(1000);
  });

  it('computeDurationQuantiles is a thin wrapper over computeFieldQuantiles(arr, FIELDS.DURATION)', () => {
    const arr = new Float64Array(10 * FIELDS.STRIDE);
    for (let i = 0; i < 10; i++) arr[i * FIELDS.STRIDE + FIELDS.DURATION] = i + 1;
    expect(computeDurationQuantiles(arr)).toEqual(computeFieldQuantiles(arr, FIELDS.DURATION));
  });
});

describe('processEvent: StageCompleted backfills a missing submission time', () => {
  it('takes Submission Time from StageCompleted when StageSubmitted carried none (older Spark)', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 0 } }, s);
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 0, 'Submission Time': 1422981762069, 'Completion Time': 1422981762637 },
    }, s);
    expect(msg.data.submittedAt).toBe(1422981762069);
    expect(msg.data.completedAt - msg.data.submittedAt).toBe(568);
  });

  it('keeps the StageSubmitted time when both events carry one', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 0, 'Submission Time': 1000 } }, s);
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 0, 'Submission Time': 1200, 'Completion Time': 5000 },
    }, s);
    expect(msg.data.submittedAt).toBe(1000);
  });
});

describe('computeTaskActiveMs', () => {
  const tasks = (...pairs) => {
    const arr = new Float64Array(pairs.length * FIELDS.STRIDE);
    pairs.forEach(([launch, finish], i) => {
      arr[i * FIELDS.STRIDE + FIELDS.LAUNCH_TIME] = launch;
      arr[i * FIELDS.STRIDE + FIELDS.FINISH_TIME] = finish;
      arr[i * FIELDS.STRIDE + FIELDS.DURATION] = finish - launch;
    });
    return arr;
  };

  it('unions overlapping task intervals and leaves out the gaps between them', () => {
    // [1000,5000) and [2000,6000) merge to 5000ms; [20000,21000) adds 1000ms; the gap does not count.
    expect(computeTaskActiveMs(tasks([2000, 6000], [1000, 5000], [20000, 21000]))).toBe(6000);
  });

  it('skips tasks missing a timestamp, and is 0 for a stage with no timed tasks', () => {
    expect(computeTaskActiveMs(tasks([0, 5000], [3000, 3000]))).toBe(0);
    expect(computeTaskActiveMs(new Float64Array(0))).toBe(0);
  });

  it('computePeakConcurrentTasks: counts the most tasks running at once; a finish frees its slot for a launch at the same instant', () => {
    // [1000,5000) [2000,6000) [3000,4000) overlap 3-deep at 3000; [6000,7000) reuses a freed slot.
    expect(computePeakConcurrentTasks(tasks([1000, 5000], [2000, 6000], [3000, 4000], [6000, 7000]))).toBe(3);
    expect(computePeakConcurrentTasks(tasks([1000, 2000], [2000, 3000]))).toBe(1);
    expect(computePeakConcurrentTasks(tasks([0, 5000]))).toBe(0);
  });
});

describe('computeTailReplayRecoveryMs', () => {
  // [launch, duration] pairs, in task-array order.
  const tasks = (...pairs) => {
    const arr = new Float64Array(pairs.length * FIELDS.STRIDE);
    pairs.forEach(([launch, duration], i) => {
      arr[i * FIELDS.STRIDE + FIELDS.LAUNCH_TIME] = launch;
      arr[i * FIELDS.STRIDE + FIELDS.FINISH_TIME] = launch + duration;
      arr[i * FIELDS.STRIDE + FIELDS.DURATION] = duration;
    });
    return arr;
  };

  it('is 0 for a single-task stage, an empty one, or a zero median', () => {
    expect(computeTailReplayRecoveryMs(tasks([0, 10000]), 10000, 1)).toBe(0);
    expect(computeTailReplayRecoveryMs(new Float64Array(0), 100, 1)).toBe(0);
    expect(computeTailReplayRecoveryMs(tasks([0, 0], [0, 500]), 0, 2)).toBe(0);
  });

  it('a lone late straggler: recovers its whole excess over the median', () => {
    // 2 slots, launch order: four 100ms tasks end at 200 on both slots, then the 1000ms one ends at
    // 1200. Capped at P50 (100) it ends at 300: 900 recovered.
    const arr = tasks([0, 100], [0, 100], [100, 100], [100, 100], [200, 1000]);
    expect(computeTailReplayRecoveryMs(arr, 100, 2)).toBe(900);
  });

  it('a straggler launched first overlaps the other tasks: recovers less than its excess', () => {
    // 2 slots: the 1000ms task holds slot 0 while nine 100ms tasks run back to back on slot 1 (end
    // 900), so the stage ends at 1000. Capped at 100, the ten 100ms tasks split 5/5: end 500.
    // The P50/max estimate claimed max(1000 - 100, 900 / 2) = 900.
    const arr = tasks([0, 1000], ...Array.from({ length: 9 }, (_, i) => [i * 100, 100]));
    expect(computeTailReplayRecoveryMs(arr, 100, 2)).toBe(500);
  });

  it('ties: equal free slots are interchangeable, equal launch times keep the task-array order', () => {
    // All launch at 0 on 2 slots. [100,100,100,900]: the third 100ms takes one of two slots tied at
    // 100 (either gives 200), the 900ms one the other: end 1000; capped, end 200: 800.
    expect(computeTailReplayRecoveryMs(tasks([0, 100], [0, 100], [0, 100], [0, 900]), 100, 2)).toBe(800);
    // [900,100,100,100]: the 900ms task first, the three 100ms run 300 on the other slot: end 900;
    // capped, end 200: 700.
    expect(computeTailReplayRecoveryMs(tasks([0, 900], [0, 100], [0, 100], [0, 100]), 100, 2)).toBe(700);
    // Two identical stragglers tied at the same launch: both slots end at 1100; capped, 200: 900.
    expect(computeTailReplayRecoveryMs(tasks([0, 100], [0, 100], [100, 1000], [100, 1000]), 100, 2)).toBe(900);
  });

  it('no observed slots runs serially; more slots than tasks runs every task at once', () => {
    // 1 slot: 100 + 100 + 1000 = 1200, capped 300: 900.
    expect(computeTailReplayRecoveryMs(tasks([0, 100], [0, 100], [0, 1000]), 100, 0)).toBe(900);
    // 100 slots for 3 tasks: end 1000, capped 100: 900.
    expect(computeTailReplayRecoveryMs(tasks([0, 100], [0, 100], [0, 1000]), 100, 100)).toBe(900);
  });

  it('a task exactly at 4x P50 is not capped', () => {
    expect(computeTailReplayRecoveryMs(tasks([0, 100], [0, 100], [0, 400]), 100, 1)).toBe(0);
  });
});

describe('classifySpill', () => {
  it('returns unclassified for empty array', () => {
    expect(classifySpill(new Float64Array(0))).toBe('unclassified');
  });

  it('returns skew when ≥80% tasks have zero spill', () => {
    const arr = new Float64Array(10 * FIELDS.STRIDE);
    arr[9 * FIELDS.STRIDE + FIELDS.MEM_SPILLED] = 1000;
    expect(classifySpill(arr)).toBe('skew');
  });

  it('returns volume when <20% tasks have zero spill', () => {
    const arr = new Float64Array(10 * FIELDS.STRIDE);
    for (let i = 0; i < 9; i++) arr[i * FIELDS.STRIDE + FIELDS.MEM_SPILLED] = 1000;
    expect(classifySpill(arr)).toBe('volume');
  });

  it('returns unclassified for mixed case', () => {
    const arr = new Float64Array(10 * FIELDS.STRIDE);
    for (let i = 0; i < 5; i++) arr[i * FIELDS.STRIDE + FIELDS.MEM_SPILLED] = 1000;
    expect(classifySpill(arr)).toBe('unclassified');
  });
});

describe('full stage cycle', () => {
  it('StageCompleted after TaskEnd produces correct StageAggregate', () => {
    const s = createState();

    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Stage Name': 'agg', 'Details': '', 'Submission Time': 100 } }, s);

    for (const [launch, finish, spill] of [[100, 200, 0], [200, 400, 1000]]) {
      processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
        'Task Info': { 'Task ID': 0, 'Launch Time': launch, 'Finish Time': finish, 'Failed': false, 'Killed': false },
        'Task Metrics': {
          'JVM GC Time': 10, 'Memory Bytes Spilled': spill, 'Disk Bytes Spilled': 0,
          'Executor Run Time': finish - launch,
          'Shuffle Read Metrics': { 'Remote Bytes Read': 0, 'Local Bytes Read': 50, 'Fetch Wait Time': 0 },
          'Shuffle Write Metrics': { 'Shuffle Bytes Written': 20 },
          'Input Metrics': { 'Bytes Read': 0 }, 'Output Metrics': { 'Bytes Written': 0 },
        }
      }, s);
    }

    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 500 } }, s);

    expect(msg.type).toBe('stage');
    const d = msg.data;
    expect(d.taskCount).toBe(2);
    expect(d.shuffleReadBytes).toBe(100);
    expect(d.spillClassification).toBe('unclassified');
    expect(d.taskDurationMax).toBe(200);
    expect(s.taskStore.has(1)).toBe(true);
    // shuffleReadBytes > 0 → REDUCE
    expect(d.stageType).toBe('REDUCE');
  });

  it('msg.data never carries the internal taskAttempts field', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Stage Name': 'agg', 'Details': '', 'Submission Time': 100 } }, s);

    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': 0, 'Launch Time': 100, 'Finish Time': 200, 'Failed': false, 'Killed': false },
      'Task Metrics': {
        'JVM GC Time': 10, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0,
        'Executor Run Time': 100,
        'Shuffle Read Metrics': { 'Remote Bytes Read': 0, 'Local Bytes Read': 0, 'Fetch Wait Time': 0 },
        'Shuffle Write Metrics': { 'Shuffle Bytes Written': 0 },
        'Input Metrics': { 'Bytes Read': 0 }, 'Output Metrics': { 'Bytes Written': 0 },
      }
    }, s);

    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 500 } }, s);

    expect('taskAttempts' in msg.data).toBe(false);
  });

  it('a duplicate StageCompleted for an already-finalized stage does not throw', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Stage Name': 'agg', 'Details': '', 'Submission Time': 100 } }, s);

    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': 0, 'Launch Time': 100, 'Finish Time': 200, 'Failed': false, 'Killed': false },
      'Task Metrics': {
        'JVM GC Time': 10, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0,
        'Executor Run Time': 100,
        'Shuffle Read Metrics': { 'Remote Bytes Read': 0, 'Local Bytes Read': 0, 'Fetch Wait Time': 0 },
        'Shuffle Write Metrics': { 'Shuffle Bytes Written': 0 },
        'Input Metrics': { 'Bytes Read': 0 }, 'Output Metrics': { 'Bytes Written': 0 },
      }
    }, s);

    const stageCompletedEvent = { Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 500 } };

    const firstMsg = processEvent(stageCompletedEvent, s);
    expect(firstMsg.type).toBe('stage');

    let secondMsg;
    expect(() => { secondMsg = processEvent(stageCompletedEvent, s); }).not.toThrow();
    expect(secondMsg).toBeNull();
  });
});

describe('stageType classification', () => {
  function makeStage(shuffleRead) {
    const s = createState();
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 2, 'Stage Name': 'test', 'Details': '', 'Submission Time': 0 },
    }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 2, 'Stage Attempt ID': 0,
      'Task Info': { 'Task ID': 0, 'Launch Time': 0, 'Finish Time': 100, 'Failed': false, 'Killed': false },
      'Task Metrics': {
        'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0,
        'Executor Run Time': 100,
        'Shuffle Read Metrics': { 'Remote Bytes Read': shuffleRead, 'Local Bytes Read': 0, 'Fetch Wait Time': 0 },
        'Shuffle Write Metrics': { 'Shuffle Bytes Written': 0 },
        'Input Metrics': { 'Bytes Read': 0 }, 'Output Metrics': { 'Bytes Written': 0 },
      },
    }, s);
    return processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 2, 'Completion Time': 200 } }, s);
  }

  it('returns MAP when shuffleReadBytes is 0', () => {
    expect(makeStage(0).data.stageType).toBe('MAP');
  });

  it('returns REDUCE when shuffleReadBytes > 0', () => {
    expect(makeStage(1024).data.stageType).toBe('REDUCE');
  });
});

describe('processEvent: StageSubmitted populates new fields', () => {
  it('captures parentIds, initializes empty hostStats/failureReasons, zero speculativeTasks', () => {
    const s = createState();
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 7, 'Stage Name': 'agg', 'Submission Time': 10, 'Parent IDs': [3, 5] },
    }, s);
    const stage = s.stages.get(7);
    expect(stage.parentIds).toEqual([3, 5]);
    expect(stage.hostStats).toBeInstanceOf(Map);
    expect(stage.hostStats.size).toBe(0);
    expect(stage.speculativeTasks).toBe(0);
    expect(stage.failureReasons).toBeInstanceOf(Map);
    expect(stage.failureReasons.size).toBe(0);
  });

  it('defaults parentIds to empty array when missing', () => {
    const s = createState();
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 },
    }, s);
    expect(s.stages.get(1).parentIds).toEqual([]);
  });
});

describe('accumulateTask: populates hostStats / speculativeTasks / failureReasons', () => {
  function setupStage(s, id = 1) {
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': id, 'Submission Time': 0 },
    }, s);
  }

  // Note: hostStats/speculativeTasks/failureReasons are now folded at
  // finalizeStage time (see Task 1 dedup refactor), not incrementally on
  // the stage object, so these assert on the StageCompleted message data
  // rather than on the pre-finalize stage object.

  it('aggregates host stats from successful tasks', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Host': 'host-A' },
      'Task Metrics': {},
    }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 300, 'Host': 'host-A' },
      'Task Metrics': {},
    }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 50, 'Host': 'host-B' },
      'Task Metrics': {},
    }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 400 } }, s);
    expect(msg.data.hostStats).toEqual(
      expect.arrayContaining([
        { host: 'host-A', taskCount: 2, totalDuration: 400 },
        { host: 'host-B', taskCount: 1, totalDuration: 50 },
      ])
    );
  });

  it('counts speculative tasks separately', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Speculative': true },
      'Task Metrics': {},
    }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Speculative': false },
      'Task Metrics': {},
    }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.speculativeTasks).toBe(1);
  });

  it('counts failure reasons for failed/killed tasks', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Failed': true },
      'Task End Reason': { Reason: 'FetchFailed' },
      'Task Metrics': {},
    }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Failed': true },
      'Task End Reason': { Reason: 'FetchFailed' },
      'Task Metrics': {},
    }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Killed': true },
      'Task End Reason': { Reason: 'TaskKilled' },
      'Task Metrics': {},
    }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.failedTasks).toBe(3);
    expect(msg.data.failureReasons).toEqual(
      expect.arrayContaining([
        { reason: 'FetchFailed', count: 2 },
        { reason: 'TaskKilled', count: 1 },
      ])
    );
  });
});

describe('processEvent: SQLExecution accumulator tracking', () => {
  it('createState includes accumState as empty Map', () => {
    const s = createState();
    expect(s.accumState).toBeInstanceOf(Map);
    expect(s.accumState.size).toBe(0);
  });

  it('SparkListenerSQLExecutionStart stores sparkPlanInfo on exec', () => {
    const s = createState();
    const planInfo = { nodeName: 'Filter', simpleString: 'Filter (x = 1)', children: [], metadata: {}, metrics: [] };
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 7, description: 'SELECT', time: 1000,
      physicalPlanDescription: '', sparkPlanInfo: planInfo,
    }, s);
    expect(s.sqlExecutions.get(7).sparkPlanInfo).toEqual(planInfo);
    expect(s.accumState.has(7)).toBe(true);
    expect(s.accumState.get(7).size).toBe(0);
  });

  it('SparkListenerSQLExecutionStart with no sparkPlanInfo stores null', () => {
    const s = createState();
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 8, description: 'q', time: 1000,
      physicalPlanDescription: '',
    }, s);
    expect(s.sqlExecutions.get(8).sparkPlanInfo).toBeNull();
    expect(s.accumState.has(8)).toBe(false);
  });

  it('SparkListenerDriverAccumUpdates accumulates deltas', () => {
    const s = createState();
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 5, description: 'q', time: 1000,
      physicalPlanDescription: '',
      sparkPlanInfo: { nodeName: 'N', simpleString: 'N', children: [], metadata: {}, metrics: [] },
    }, s);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 5, accumUpdates: [[94, 10], [95, 20]],
    }, s);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 5, accumUpdates: [[94, 5]],
    }, s);
    const m = s.accumState.get(5);
    expect(m.get(94)).toBe(15); // 10 + 5
    expect(m.get(95)).toBe(20);
  });

  it('SparkListenerDriverAccumUpdates is silently discarded when execution already resolved', () => {
    const s = createState();
    // no accumState entry for executionId 99 → late update
    const result = processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 99, accumUpdates: [[1, 42]],
    }, s);
    expect(result).toBeNull();
    expect(s.accumState.has(99)).toBe(false);
  });
});

describe('processEvent: SparkListenerSQLAdaptiveExecutionUpdate', () => {
  function makeExecStart(executionId, planInfo) {
    return {
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId, description: 'q', time: 1000, physicalPlanDescription: 'orig plan',
      sparkPlanInfo: planInfo,
    };
  }
  const simplePlan = (name) => ({ nodeName: name, simpleString: name, children: [], metadata: {}, metrics: [] });

  it('overwrites sparkPlanInfo for a known execution, never retaining physicalPlanDescription', () => {
    const state = createState();
    processEvent(makeExecStart(1, simplePlan('OldPlan')), state);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate',
      executionId: 1, physicalPlanDescription: 'new plan',
      sparkPlanInfo: simplePlan('NewPlan'),
    }, state);

    const exec = state.sqlExecutions.get(1);
    expect(exec.sparkPlanInfo.nodeName).toBe('NewPlan');
    expect(exec.physicalPlanDescription).toBeUndefined();
  });

  it('last-write-wins across two successive updates for the same execution', () => {
    const state = createState();
    processEvent(makeExecStart(1, simplePlan('OldPlan')), state);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate',
      executionId: 1, physicalPlanDescription: 'update 1', sparkPlanInfo: simplePlan('Update1'),
    }, state);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate',
      executionId: 1, physicalPlanDescription: 'update 2', sparkPlanInfo: simplePlan('Update2'),
    }, state);

    expect(state.sqlExecutions.get(1).sparkPlanInfo.nodeName).toBe('Update2');
  });

  it('is silently discarded for an unseen executionId (out-of-order or truncated log)', () => {
    const state = createState();
    const result = processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate',
      executionId: 999, sparkPlanInfo: simplePlan('X'),
    }, state);
    expect(result).toBeNull();
    expect(state.sqlExecutions.has(999)).toBe(false);
  });

  it('sets hadAdaptiveUpdate to true on the execution record once updated, false before', () => {
    const state = createState();
    processEvent(makeExecStart(1, simplePlan('OldPlan')), state);
    expect(state.sqlExecutions.get(1).hadAdaptiveUpdate).toBe(false);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate',
      executionId: 1, sparkPlanInfo: simplePlan('New'),
    }, state);
    expect(state.sqlExecutions.get(1).hadAdaptiveUpdate).toBe(true);
  });

  // Regression for the browser-side gap: mutating state.sqlExecutions'
  // in-memory object is not enough, the real worker posts a `sql` message
  // via self.postMessage (structured clone), so the main thread only ever
  // sees a snapshot frozen at the time of THAT message. Without a re-emitted
  // 'sql' message here, a browser-side appModel.sql entry never observes
  // hadAdaptiveUpdate flipping to true.
  it('returns a fresh sql-type message reflecting hadAdaptiveUpdate: true, not null', () => {
    const state = createState();
    processEvent(makeExecStart(1, simplePlan('OldPlan')), state);
    const result = processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate',
      executionId: 1, physicalPlanDescription: 'new plan', sparkPlanInfo: simplePlan('NewPlan'),
    }, state);

    expect(result).not.toBeNull();
    expect(result.type).toBe('sql');
    expect(result.data.id).toBe(1);
    expect(result.data.hadAdaptiveUpdate).toBe(true);
    // The raw plan stays worker-side (the main thread reads the resolved sqlPlan tree instead).
    expect(result.data.sparkPlanInfo).toBeNull();
    expect(state.sqlExecutions.get(1).sparkPlanInfo.nodeName).toBe('NewPlan');
    expect(result.data.physicalPlanDescription).toBeUndefined();
    // Shallow copy, not the same mutable reference the worker keeps mutating
    // (mirrors the real self.postMessage structured-clone boundary).
    expect(result.data).not.toBe(state.sqlExecutions.get(1));
  });

  it('preserves an existing sparkPlanInfo when the update event carries none (does not wipe it with null)', () => {
    const state = createState();
    processEvent(makeExecStart(1, simplePlan('OldPlan')), state);
    const result = processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate',
      executionId: 1, physicalPlanDescription: 'new plan',
    }, state);

    expect(state.sqlExecutions.get(1).sparkPlanInfo.nodeName).toBe('OldPlan');
    expect(result.data.sparkPlanInfo).toBeNull();
  });
});

describe('finalizeStage: converts Maps to arrays + computes stragglerCount', () => {
  function setupStage(s, id = 1) {
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': id, 'Submission Time': 0 },
    }, s);
  }

  it('emits hostStats and failureReasons as arrays in the stage message', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Host': 'h1' },
      'Task Metrics': {},
    }, s);
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 },
    }, s);
    expect(Array.isArray(msg.data.hostStats)).toBe(true);
    expect(msg.data.hostStats[0]).toEqual({ host: 'h1', taskCount: 1, totalDuration: 100 });
    expect(Array.isArray(msg.data.failureReasons)).toBe(true);
  });

  it('computes stragglerCount as tasks with duration > 4 * P50', () => {
    const s = createState();
    setupStage(s);
    // 5 tasks: 4 short (100-300ms), 1 long (1000ms). P50 = 100, threshold = 400, straggler = 1.
    for (const finish of [100, 100, 100, 300]) {
      processEvent({
        Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
        'Task Info': { 'Launch Time': 0, 'Finish Time': finish },
        'Task Metrics': {},
      }, s);
    }
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 1000 },
      'Task Metrics': {},
    }, s);
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 1100 },
    }, s);
    expect(msg.data.stragglerCount).toBe(1);
    // The straggler's excess over P50, the input to impact-estimator's tail claim.
    expect(msg.data.stragglerExcessMs).toBe(900);
    // The longest task under the threshold: what a straggler fix leaves.
    expect(msg.data.longestNonStragglerMs).toBe(300);
    // Every task launches at 0 (no timed slots, so one): 1600ms serially, 700ms with the straggler
    // capped at P50.
    expect(msg.data.tailReplayRecoveryMs).toBe(900);
  });

  it('stragglerCount is 0 when all tasks are short', () => {
    const s = createState();
    setupStage(s);
    for (let i = 0; i < 5; i++) {
      processEvent({
        Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
        'Task Info': { 'Launch Time': 0, 'Finish Time': 100 },
        'Task Metrics': {},
      }, s);
    }
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 },
    }, s);
    expect(msg.data.stragglerCount).toBe(0);
    expect(msg.data.tailReplayRecoveryMs).toBe(0);
  });

  it('stragglerCount is 0 when all task durations are 0 (p50 === 0 guard)', () => {
    const s = createState();
    setupStage(s);
    for (let i = 0; i < 5; i++) {
      processEvent({
        Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
        'Task Info': { 'Launch Time': 0, 'Finish Time': 0 },
        'Task Metrics': {},
      }, s);
    }
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 100 },
    }, s);
    expect(msg.data.stragglerCount).toBe(0);
  });

  it('preserves speculativeTasks and parentIds on the finalized stage message', () => {
    const s = createState();
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 0, 'Parent IDs': [2, 4] },
    }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Speculative': true },
      'Task Metrics': {},
    }, s);
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 },
    }, s);
    expect(msg.data.parentIds).toEqual([2, 4]);
    expect(msg.data.speculativeTasks).toBe(1);
  });

  it('adds shuffleRead/spillMem/spillDisk P50/P95/max fields to the stage message', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100 },
      'Task Metrics': {
        'Shuffle Read Metrics': { 'Remote Bytes Read': 200, 'Local Bytes Read': 0 },
        'Memory Bytes Spilled': 50, 'Disk Bytes Spilled': 10,
      },
    }, s);
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 },
    }, s);
    expect(msg.data.shuffleReadP50).toBe(200);
    expect(msg.data.shuffleReadP95).toBe(200);
    expect(msg.data.shuffleReadMax).toBe(200);
    expect(msg.data.spillMemP50).toBe(50);
    expect(msg.data.spillMemP95).toBe(50);
    expect(msg.data.spillMemMax).toBe(50);
    expect(msg.data.spillDiskP50).toBe(10);
    expect(msg.data.spillDiskP95).toBe(10);
    expect(msg.data.spillDiskMax).toBe(10);
  });
});

describe('finalizeStage: shuffle-read + spill quantiles on a real fixture (item A)', () => {
  const fixturePath = fileURLToPath(new URL('../../../examples/private-log-05', import.meta.url));

  it.skipIf(!existsSync(fixturePath))(
    'includes numeric shuffleRead/spillMem/spillDisk P50/P95/max with P50 <= P95 <= max (private-log-05: gitignored, local-only)',
    async () => {
      const lines = await collectMatchingLines(fixturePath, [
        '"SparkListenerStageSubmitted"',
        '"SparkListenerTaskEnd"',
        '"SparkListenerStageCompleted"',
      ]);
      const state = createState();
      const stageMsgs = [];
      for (const line of lines) dispatchLine(line, state, m => { if (m.type === 'stage') stageMsgs.push(m); });

      expect(stageMsgs.length).toBeGreaterThan(0);
      const withTasks = stageMsgs.find(m => m.data.taskCount > 0);
      expect(withTasks).toBeTruthy();
      const d = withTasks.data;
      for (const field of [
        'shuffleReadP50', 'shuffleReadP95', 'shuffleReadMax',
        'spillMemP50', 'spillMemP95', 'spillMemMax',
        'spillDiskP50', 'spillDiskP95', 'spillDiskMax',
      ]) {
        expect(typeof d[field]).toBe('number');
      }
      expect(d.shuffleReadP50).toBeLessThanOrEqual(d.shuffleReadP95);
      expect(d.shuffleReadP95).toBeLessThanOrEqual(d.shuffleReadMax);
      expect(d.spillMemP50).toBeLessThanOrEqual(d.spillMemP95);
      expect(d.spillMemP95).toBeLessThanOrEqual(d.spillMemMax);
      expect(d.spillDiskP50).toBeLessThanOrEqual(d.spillDiskP95);
      expect(d.spillDiskP95).toBeLessThanOrEqual(d.spillDiskMax);
    }
  );
});

describe('processEvent: SparkListenerSQLExecutionEnd tree resolution', () => {
  function makeExecStart(executionId, planInfo) {
    return {
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId, description: 'q', time: 1000,
      physicalPlanDescription: '',
      sparkPlanInfo: planInfo,
    };
  }

  function makeExecEnd(executionId, time = 2000) {
    return {
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd',
      executionId, time,
    };
  }

  it('posts sqlPlan message with resolved PlanNode tree', () => {
    const s = createState();
    const planInfo = {
      nodeName: 'SortMergeJoin', simpleString: 'SortMergeJoin [id]',
      children: [
        { nodeName: 'Exchange', simpleString: 'hashpartitioning(id, 200)',
          children: [], metadata: {},
          metrics: [{ name: 'records written', accumulatorId: 10, metricType: 'sum' }] },
      ],
      metadata: {},
      metrics: [{ name: 'number of output rows', accumulatorId: 5, metricType: 'sum' }],
    };
    processEvent(makeExecStart(1, planInfo), s);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 1, accumUpdates: [[5, 1000], [10, 500]],
    }, s);

    const msg = processEvent(makeExecEnd(1), s);

    expect(msg).not.toBeNull();
    expect(msg.type).toBe('sqlPlan');
    expect(msg.data.executionId).toBe(1);

    const tree = msg.data.planTree;
    expect(tree.name).toBe('SortMergeJoin');
    expect(tree.detail).toBe('SortMergeJoin [id]');
    expect(tree.metrics).toEqual([{ name: 'number of output rows', value: 1000, metricType: 'sum' }]);
    expect(tree.children).toHaveLength(1);

    const child = tree.children[0];
    expect(child.name).toBe('Exchange');
    expect(child.children[0].metrics).toEqual([{ name: 'records written', value: 500, metricType: 'sum' }]);
  });

  it('keeps the resolved plan in the assembled model when SQLExecutionEnd repeats', () => {
    // Each message is cloned, as the browser worker's postMessage does, so the model never shares
    // the worker's own record.
    const s = createState();
    const appModel = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null };
    const handlers = createModelCallbacks(appModel, {});
    const post = (msg) => { if (msg) routeMessage(structuredClone(msg), handlers); };
    post(processEvent(makeExecStart(1, { nodeName: 'Project', simpleString: 'Project [id]', children: [], metadata: {}, metrics: [] }), s));
    post(processEvent(makeExecEnd(1), s));
    post(processEvent(makeExecEnd(1, 3000), s));
    expect(appModel.sql.get(1).planTree?.name).toBe('Project');
  });

  it('resolves the new plan when a whole SQL execution (start and end) repeats', () => {
    const s = createState();
    const appModel = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null };
    const handlers = createModelCallbacks(appModel, {});
    const post = (msg) => { if (msg) routeMessage(structuredClone(msg), handlers); };
    post(processEvent(makeExecStart(1, { nodeName: 'Project', simpleString: 'Project [id]', children: [], metadata: {}, metrics: [] }), s));
    post(processEvent(makeExecEnd(1), s));
    post(processEvent(makeExecStart(1, { nodeName: 'Filter', simpleString: 'Filter', children: [], metadata: {}, metrics: [] }), s));
    post(processEvent(makeExecEnd(1, 3000), s));
    expect(appModel.sql.get(1).planTree?.name).toBe('Filter');
  });

  it('omits metrics whose accumulatorId has no value in accumState', () => {
    const s = createState();
    const planInfo = {
      nodeName: 'Filter', simpleString: 'Filter',
      children: [], metadata: {},
      metrics: [{ name: 'rows', accumulatorId: 99, metricType: 'sum' }],
    };
    processEvent(makeExecStart(2, planInfo), s);
    // no DriverAccumUpdates posted → accId 99 has no value
    const msg = processEvent(makeExecEnd(2), s);
    expect(msg.data.planTree.metrics).toHaveLength(0);
  });

  it('clears accumState entry after posting sqlPlan', () => {
    const s = createState();
    const planInfo = { nodeName: 'N', simpleString: 'N', children: [], metadata: {}, metrics: [] };
    processEvent(makeExecStart(3, planInfo), s);
    processEvent(makeExecEnd(3), s);
    expect(s.accumState.has(3)).toBe(false);
  });

  it('posts sql message with endTime (no sqlPlan) when sparkPlanInfo is null', () => {
    const s = createState();
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 4, description: 'q', time: 1000,
      physicalPlanDescription: '',
    }, s);
    const msg = processEvent(makeExecEnd(4), s);
    expect(msg).not.toBeNull();
    expect(msg.type).toBe('sql');
    expect(msg.data.endTime).toBe(2000);
  });

  it('posts sql message with endTime (no sqlPlan) when root nodeName is empty string', () => {
    const s = createState();
    const planInfo = { nodeName: '', simpleString: '', children: [], metadata: {}, metrics: [] };
    processEvent(makeExecStart(5, planInfo), s);
    const msg = processEvent(makeExecEnd(5), s);
    expect(msg).not.toBeNull();
    expect(msg.type).toBe('sql');
    expect(msg.data.endTime).toBe(2000);
  });

  it('resolves deeply nested tree iteratively without stack overflow', () => {
    // 500-level deep chain
    let node = { nodeName: 'Leaf', simpleString: 'Leaf', children: [], metadata: {}, metrics: [] };
    for (let i = 0; i < 500; i++) {
      node = { nodeName: `Node${i}`, simpleString: `Node${i}`, children: [node], metadata: {}, metrics: [] };
    }
    const s = createState();
    processEvent(makeExecStart(6, node), s);
    const msg = processEvent(makeExecEnd(6), s);
    expect(msg).not.toBeNull();
    let cur = msg.data.planTree;
    while (cur.children.length > 0) cur = cur.children[0];
    expect(cur.name).toBe('Leaf');
  });
});

describe('processEvent: SparkListenerSQLExecutionEnd tree resolution, stageIds', () => {
  function makeExecStart(executionId, planInfo) {
    return {
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId, description: 'q', time: 1000, physicalPlanDescription: '',
      sparkPlanInfo: planInfo,
    };
  }
  function makeExecEnd(executionId, time = 2000) {
    return { Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd', executionId, time };
  }
  function makeJobStart(jobId, stageIds, executionId) {
    return {
      Event: 'SparkListenerJobStart', 'Job ID': jobId, 'Stage IDs': stageIds,
      Properties: { 'spark.sql.execution.id': String(executionId) },
    };
  }
  function submitStage(stageId) {
    return {
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': stageId, 'Stage Attempt ID': 0, 'Stage Name': 's', 'Number of Tasks': 1, 'Submission Time': 0 },
    };
  }
  function taskEnd(stageId, accumIds) {
    return {
      Event: 'SparkListenerTaskEnd', 'Stage ID': stageId, 'Stage Attempt ID': 0,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 10, Index: 0, Accumulables: accumIds.map((ID) => ({ ID })) },
      'Task Metrics': {},
    };
  }

  it('attaches stageIds to a node whose accumulator ran in a real task', () => {
    const state = createState();
    const planInfo = {
      nodeName: 'SortMergeJoin', simpleString: 'SortMergeJoin [id]',
      children: [{
        nodeName: 'Exchange', simpleString: 'hashpartitioning(id, 200)', children: [],
        metadata: {}, metrics: [{ name: 'records written', accumulatorId: 10, metricType: 'sum' }],
      }],
      metadata: {}, metrics: [{ name: 'number of output rows', accumulatorId: 5, metricType: 'sum' }],
    };
    processEvent(makeJobStart(1, [0], 1), state);
    processEvent(submitStage(0), state);
    processEvent(makeExecStart(1, planInfo), state);
    processEvent(taskEnd(0, [5, 10]), state);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 1, accumUpdates: [[5, 1000], [10, 500]],
    }, state);
    const msg = processEvent(makeExecEnd(1), state);

    expect(msg.data.planTree.stageIds).toEqual([0]);
    expect(msg.data.planTree.children[0].stageIds).toEqual([0]);
  });

  it('leaves stageIds absent (not []) when the node\'s accumulator never appears on any TaskEnd', () => {
    const state = createState();
    const planInfo = {
      nodeName: 'BroadcastExchange', simpleString: 'BroadcastExchange', children: [],
      metadata: {}, metrics: [{ name: 'data size', accumulatorId: 99, metricType: 'size' }],
    };
    processEvent(makeJobStart(1, [0], 1), state);
    processEvent(submitStage(0), state);
    processEvent(makeExecStart(1, planInfo), state);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 1, accumUpdates: [[99, 2048]],
    }, state);
    const msg = processEvent(makeExecEnd(1), state);

    expect(msg.data.planTree.stageIds).toBeUndefined();
  });

  it('clips out an accumulator ID that only appears in a different execution\'s stages', () => {
    const state = createState();
    const planInfo = {
      nodeName: 'ReusedSubquery', simpleString: 'ReusedSubquery', children: [],
      metadata: {}, metrics: [{ name: 'number of output rows', accumulatorId: 7, metricType: 'sum' }],
    };
    // stage 0 belongs to execution 2, not execution 1: accumulator 7 ran there.
    processEvent(makeJobStart(1, [0], 2), state);
    processEvent(submitStage(0), state);
    processEvent(taskEnd(0, [7]), state);
    // execution 1 has its own stage universe that does NOT include stage 0.
    processEvent(makeJobStart(2, [1], 1), state);
    processEvent(submitStage(1), state);
    processEvent(makeExecStart(1, planInfo), state);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 1, accumUpdates: [[7, 500]],
    }, state);
    const msg = processEvent(makeExecEnd(1), state);

    expect(msg.data.planTree.stageIds).toBeUndefined();
  });

  it('does not leak a foreign accumulator collision into an execution with no stage universe at all', () => {
    const state = createState();
    // Stage 0 belongs to a different execution (2), which never resolves
    // here; accumulator 7 is recorded as having run in stage 0.
    processEvent(submitStage(0), state);
    processEvent(taskEnd(0, [7]), state);

    const planInfo = {
      nodeName: 'ReusedSubquery', simpleString: 'ReusedSubquery', children: [],
      metadata: {}, metrics: [{ name: 'number of output rows', accumulatorId: 7, metricType: 'sum' }],
    };
    // Execution 1 gets no SparkListenerJobStart at all, so state.sqlExecStages
    // has no entry for it (executionStageIds is undefined at resolution time),
    // same as a job-less/driver-only execution in real logs.
    processEvent(makeExecStart(1, planInfo), state);
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates',
      executionId: 1, accumUpdates: [[7, 500]],
    }, state);
    const msg = processEvent(makeExecEnd(1), state);

    expect(msg.data.planTree.stageIds).toBeUndefined();
  });
});

describe('dispatchLine', () => {
  it('parses a valid line and emits the processed message', () => {
    const state = createState();
    const emitted = [];
    dispatchLine('{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"test","Timestamp":1}', state, msg => emitted.push(msg));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('app');
  });

  it('increments skippedLines and emits nothing on malformed JSON', () => {
    const state = createState();
    const emitted = [];
    dispatchLine('not json', state, msg => emitted.push(msg));
    expect(emitted).toHaveLength(0);
    expect(state.skippedLines).toBe(1);
  });

  // Unrecognized-Event and known-Event-fails-schema cases are covered in the
  // 'processEvent: unknown event' describe block above.

  it('resolves the same plan tree whether or not the line carries a physicalPlanDescription', () => {
    const plan = { nodeName: 'Scan', simpleString: 'Scan "t"', children: [], metrics: [] };
    const run = (extra) => {
      const state = createState();
      const emitted = [];
      const emit = (m) => emitted.push(m);
      dispatchLine(JSON.stringify({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart', executionId: 1, description: 'q', ...extra, sparkPlanInfo: plan, time: 0 }), state, emit);
      dispatchLine(JSON.stringify({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd', executionId: 1, time: 5 }), state, emit);
      expect(state.skippedLines).toBe(0);
      return emitted.find((m) => m.type === 'sqlPlan').data.planTree;
    };
    expect(run({ physicalPlanDescription: '== Physical Plan ==\n* Scan "t" \\ "x\\"' })).toEqual(run({}));
  });
});

// A TaskEnd in Spark's flat accumulable form skips parsing its Accumulables array (parseTaskEnd).
describe('parseTaskEnd', () => {
  const SUBMIT = '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":7,"Stage Attempt ID":0,"Stage Name":"s","Number of Tasks":1,"Submission Time":0}}';
  const taskEnd = (accumulables) => `{"Event":"SparkListenerTaskEnd","Stage ID":7,"Stage Attempt ID":0,"Task Type":"ResultTask","Task End Reason":{"Reason":"Success"},"Task Info":{"Task ID":1,"Index":0,"Launch Time":0,"Finish Time":100,"Failed":false,"Accumulables":[${accumulables}]},"Task Metrics":{"Executor Run Time":90}}`;
  const FLAT = '{"ID":42,"Name":"number of output rows","Update":"1","Value":"1","Internal":true,"Count Failed Values":true,"Metadata":"sql"},{"ID":43,"Name":"internal.metrics.executorRunTime","Update":90,"Value":90,"Internal":true,"Count Failed Values":true}';
  const OTHER_SHAPES = [
    '{"ID":42,"Name":"internal.metrics.updatedBlockStatuses","Update":[{"Block ID":"rdd_1_0","Status":{"Memory Size":1}}],"Internal":true}',
    '{"ID":42,"Name":"a]}{\\"ID\\":9","Update":1}', // brackets and an escaped `{"ID":` inside a Name
    '{"Name":"x","ID":42}',
    '{"ID":12345678901234567,"Name":"x"}',
    '{"ID": 42}',
  ];

  it('reduces flat entries to their IDs and parses the rest of the line exactly', () => {
    const line = taskEnd(FLAT);
    const full = JSON.parse(line);
    full['Task Info'].Accumulables = [{ ID: 42 }, { ID: 43 }];
    expect(parseTaskEnd(line)).toEqual(full);
    expect(parseTaskEnd(taskEnd(''))).toEqual(JSON.parse(taskEnd('')));
  });

  it('returns null for any other shape, a non-TaskEnd line or a malformed one', () => {
    for (const accumulables of OTHER_SHAPES) expect(parseTaskEnd(taskEnd(accumulables))).toBeNull();
    expect(parseTaskEnd(SUBMIT)).toBeNull();
    expect(parseTaskEnd(taskEnd(FLAT).slice(0, -1))).toBeNull();
  });

  it('records the same accumulator IDs through dispatchLine as a whole-line parse', () => {
    for (const accumulables of [FLAT, ...OTHER_SHAPES]) {
      const viaLine = createState();
      for (const line of [SUBMIT, taskEnd(accumulables)]) dispatchLine(line, viaLine, () => {});
      const viaEvent = createState();
      for (const line of [SUBMIT, taskEnd(accumulables)]) processEvent(JSON.parse(line), viaEvent);
      expect(viaLine.skippedLines).toBe(0);
      expect(viaLine.evidenceInputs.taskRecords).toBe(1);
      expect(viaLine.taskAccumStages).toEqual(viaEvent.taskAccumStages);
    }
    const malformed = createState();
    dispatchLine(taskEnd(FLAT).slice(0, -1), malformed, () => {});
    expect(malformed.skippedLines).toBe(1);
  });
});

// An open execution's AQE updates are held as text and only the last is parsed (deferAdaptiveUpdate).
describe('dispatchLine: deferred AQE updates', () => {
  const START = (id) => JSON.stringify({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart', executionId: id, description: 'q', sparkPlanInfo: { nodeName: 'Initial', children: [], metrics: [] }, time: 0 });
  const UPDATE = (id, nodeName) => `{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate","executionId":${id},"physicalPlanDescription":"p","sparkPlanInfo":${nodeName == null ? 'null' : JSON.stringify({ nodeName, children: [], metrics: [] })}}`;
  const END = (id) => JSON.stringify({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd', executionId: id, time: 5 });
  const run = (lines) => {
    const state = createState();
    const emitted = [];
    for (const line of lines) dispatchLine(line, state, (m) => emitted.push(m));
    return { state, emitted, planRoot: emitted.find((m) => m.type === 'sqlPlan')?.data.planTree.name };
  };

  it('resolves the last update\'s plan and never parses the ones it superseded', () => {
    const malformed = UPDATE(1, 'First').slice(0, -2) + ',}}'; // superseded before anything reads it
    const { state, planRoot } = run([START(1), malformed, UPDATE(1, 'Second'), UPDATE(1, 'Last'), END(1)]);
    expect(planRoot).toBe('Last');
    expect(state.skippedLines).toBe(0);
    expect(state.sqlExecutions.get(1).hadAdaptiveUpdate).toBe(true);
  });

  it('keeps the previous plan when a later update carries none', () => {
    expect(run([START(1), UPDATE(1, 'Planned'), UPDATE(1, null), END(1)]).planRoot).toBe('Planned');
  });

  it('checks a line joined across chunks on its first and last pieces, with the same result', () => {
    const lines = [START(1), UPDATE(1, 'First').slice(0, -2) + ',}}', UPDATE(1, 'Second'), UPDATE(1, 'Last'), END(1)];
    // A 5-char head is too short to hold the prefix and falls back to the line; 130 chars holds it.
    for (const cut of [5, 130]) {
      const decoder = buildChunkDecoder();
      const state = createState();
      const emitted = [];
      const seen = [];
      for (const line of lines) {
        const bytes = new TextEncoder().encode(`${line}\n`);
        for (const part of [bytes.subarray(0, cut), bytes.subarray(cut)]) {
          const joined = [];
          decoder.decode(part, joined).forEach((decoded, i) => {
            const parts = joined.find((j) => j.index === i);
            if (parts) seen.push(decoded.startsWith(parts.head) && decoded.endsWith(parts.tail) && parts.head.length === cut);
            dispatchLine(decoded, state, (m) => emitted.push(m), parts);
          });
        }
      }
      expect(seen).toEqual(lines.filter((l) => l.length > cut).map(() => true)); // shorter lines aren't split
      expect(emitted.find((m) => m.type === 'sqlPlan')?.data.planTree.name).toBe('Last');
      expect(state.skippedLines).toBe(0);
    }
  });

  it('parses updates at once for an execution that already ended or was never started', () => {
    const { state } = run([START(1), END(1), UPDATE(1, 'Late'), UPDATE(2, 'Unknown')]);
    expect(state.pendingAdaptiveUpdates.size).toBe(0);
    expect(state.sqlExecutions.get(1).sparkPlanInfo.nodeName).toBe('Late');
  });

  it('applies a never-ended execution\'s latest update at parse completion', () => {
    const appStart = '{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"t","Timestamp":0}';
    const { state, emitted } = run([appStart, START(1), UPDATE(1, 'Latest')]);
    expect(state.sqlExecutions.get(1).sparkPlanInfo.nodeName).toBe('Initial');
    emitParseCompletion(state, (m) => emitted.push(m), 2);
    expect(state.sqlExecutions.get(1).sparkPlanInfo.nodeName).toBe('Latest');
    const sqlMsgs = emitted.filter((m) => m.type === 'sql');
    expect(sqlMsgs[sqlMsgs.length - 1].data.hadAdaptiveUpdate).toBe(true);
    expect(emitted.findIndex((m) => m.type === 'sql' && m.data.hadAdaptiveUpdate)).toBeLessThan(emitted.findIndex((m) => m.type === 'done'));
  });
});

describe('stripPlanDescription', () => {
  const PREFIX = '{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate","executionId":3,';

  it('empties the description string, keeping every other field byte-identical', () => {
    const line = `${PREFIX}"physicalPlanDescription":"plan text","sparkPlanInfo":{"nodeName":"N"}}`;
    expect(stripPlanDescription(line)).toBe(`${PREFIX}"physicalPlanDescription":"","sparkPlanInfo":{"nodeName":"N"}}`);
  });

  it('skips escaped quotes and stops at a quote preceded by an escaped backslash', () => {
    const value = JSON.stringify('a "quoted" name ending in a backslash \\');
    const line = `${PREFIX}"physicalPlanDescription":${value},"sparkPlanInfo":null}`;
    expect(JSON.parse(stripPlanDescription(line))).toEqual({ ...JSON.parse(line), physicalPlanDescription: '' });
  });

  it('leaves non-SQL lines, key-less lines and unterminated values untouched', () => {
    const taskEnd = '{"Event":"SparkListenerTaskEnd","physicalPlanDescription":"x"}';
    expect(stripPlanDescription(taskEnd)).toBe(taskEnd);
    const noKey = `${PREFIX}"sparkPlanInfo":null}`;
    expect(stripPlanDescription(noKey)).toBe(noKey);
    const truncated = `${PREFIX}"physicalPlanDescription":"cut off \\"`;
    expect(stripPlanDescription(truncated)).toBe(truncated);
  });
});

function fakeFetchReturning(zipBytes, { contentLength = zipBytes.length, ok = true, status = 200, jsonBody = null, contentType = null } = {}) {
  return async () => ({
    ok, status,
    headers: { get: (name) => {
      const key = name.toLowerCase();
      if (key === 'content-length') return String(contentLength);
      if (key === 'content-type') return contentType;
      return null;
    }},
    async json() {
      if (jsonBody === null) throw new SyntaxError('Unexpected end of JSON input');
      return jsonBody;
    },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: zipBytes };
          },
        };
      },
    },
  });
}

describe('runParseFromUrl', () => {
  const validRequest = {
    baseUrl: 'http://shs.example:18080/',
    appId: 'application_1_1',
    attemptId: null,
  };

  it('fetches, unzips, and parses a single-entry event log', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"test","Timestamp":1}\n{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n';
    const zipBytes = zipSync({ 'application_test_1': strToU8(ndjson) });
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    });
    expect(emitted.some(m => m.type === 'app')).toBe(true);
    expect(emitted.some(m => m.type === 'done')).toBe(true);
    expect(emitted.some(m => m.type === 'error')).toBe(false);
  });

  it('requests the same-origin proxy with the normalized encoded attempt', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"a","App Name":"t","Timestamp":1}\n';
    const zipBytes = zipSync({ 'application_9_1': strToU8(ndjson) });
    const state = createState();
    let calledUrl = null;
    await runParseFromUrl({
      baseUrl: 'http://shs.example:18080/shs/',
      appId: 'application_9_1',
      attemptId: 'attempt-2',
    }, state, {
      fetchImpl: async (url) => { calledUrl = url; return fakeFetchReturning(zipBytes)(); },
      emit: () => {},
    });
    expect(calledUrl).toBe('/shs-proxy?baseUrl=http%3A%2F%2Fshs.example%3A18080%2Fshs%2F&appId=application_9_1&attemptId=attempt-2');
  });

  it('decodes an lz4-suffixed entry with decodeLz4Block before parsing', async () => {
    // Build a minimal single-block LZ4Block-framed NDJSON payload inline,
    // RAW method (0x10) so no compression step is needed to construct it.
    const text = '{"Event":"SparkListenerApplicationStart","App ID":"app-2","App Name":"t","Timestamp":1}\n';
    const bytes = strToU8(text);
    const header = new Uint8Array(21);
    header.set([76, 90, 52, 66, 108, 111, 99, 107], 0); // "LZ4Block"
    header[8] = 0x10; // RAW method
    new DataView(header.buffer).setInt32(9, bytes.length, true);
    new DataView(header.buffer).setInt32(13, bytes.length, true);
    const framed = new Uint8Array(header.length + bytes.length);
    framed.set(header, 0);
    framed.set(bytes, header.length);

    const zipBytes = zipSync({ 'application_test_2_1.lz4': framed });
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    });
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('t');
  });

  it('decodes a gz-suffixed entry with gunzipSync before parsing', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-4","App Name":"t4","Timestamp":1}\n{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n';
    const gzipped = gzipSync(strToU8(ndjson));
    const zipBytes = zipSync({ 'application_test_4_1.gz': gzipped });
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('t4');
  });

  it('decodes a zstd-suffixed entry with fzstd before parsing', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-z","App Name":"tz","Timestamp":1}\n{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n';
    const zipBytes = zipSync({ 'application_test_z_1.zstd': zstdSync(strToU8(ndjson)) });
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('tz');
  });

  it('decodes a zstd entry made of thousands of concatenated frames without a stack overflow', async () => {
    // Spark flushes its compression stream periodically, so one real log can be
    // thousands of concatenated zstd frames. Regression guard: the vendored fzstd
    // once self-recursed per frame and blew the JS stack (src/vendor/fzstd.js).
    const frameCount = 20000;
    const frames = [zstdSync(strToU8('{"Event":"SparkListenerApplicationStart","App ID":"app-zf","App Name":"tzf","Timestamp":1}\n'))];
    for (let i = 0; i < frameCount; i++) {
      frames.push(zstdSync(strToU8('{"Event":"SparkListenerLogStart","Spark Version":"3.5.0"}\n')));
    }
    frames.push(zstdSync(strToU8('{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n')));
    const totalLength = frames.reduce((sum, f) => sum + f.length, 0);
    const concatenated = new Uint8Array(totalLength);
    let offset = 0;
    for (const f of frames) { concatenated.set(f, offset); offset += f.length; }

    const zipBytes = zipSync({ 'application_test_zf_1.zstd': concatenated });
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('tzf');
  });

  it('decodes a snappy-suffixed entry with decodeSnappyBlock before parsing', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-s","App Name":"ts","Timestamp":1}\n{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n';
    const zipBytes = zipSync({ 'application_test_s_1.snappy': snappyRawBlock(strToU8(ndjson)) });
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('ts');
  });

  it('skips an appstatus entry alongside the real event log entry', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-3","App Name":"t3","Timestamp":1}\n';
    const zipBytes = zipSync({
      appstatus: strToU8('{"unrelated":true}'),
      application_test_3_1: strToU8(ndjson),
    });
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('t3');
  });

  it('applies reassembleRollingEntries (drops compacted-away files) when the SHS zip contains a rolling multi-file log', async () => {
    const zipBytes = zipSync({
      'events_1_app-r': strToU8('this is not valid json and would increment skippedLines if parsed\n'),
      'events_2_app-r.compact': strToU8('{"Event":"SparkListenerApplicationStart","App ID":"app-r","App Name":"rolling","Timestamp":1}\n'),
      'events_3_app-r': strToU8('{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n'),
    });
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('rolling');
    expect(state.skippedLines).toBe(0); // events_1 (below the compact's index) must never be parsed
  });

  it('emits invalid-event-log for a rolling zip with a non-contiguous index gap', async () => {
    const zipBytes = zipSync({
      'events_1_app-gap': strToU8('{"Event":"SparkListenerApplicationStart","App ID":"app-gap","App Name":"gap","Timestamp":1}\n'),
      'events_3_app-gap': strToU8('{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n'),
    });
    const state = createState();
    const emitted = [];
    await expect(runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(zipBytes),
      emit: msg => emitted.push(msg),
    })).resolves.toBeUndefined();
    expect(emitted).toContainEqual({ type: 'error', source: 'shs', code: 'invalid-event-log', message: expect.stringMatching(/missing file\(s\)/) });
    expect(emitted.some(m => m.type === 'app')).toBe(false);
  });

  it('emits a typed local-server-unavailable error when the proxy route is absent', async () => {
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(new Uint8Array(0), { ok: false, status: 404 }),
      emit: msg => emitted.push(msg),
    });
    expect(emitted).toEqual([{ type: 'error', source: 'shs', code: 'local-server-unavailable' }]);
  });

  it('emits local-server-unavailable when a dev/SPA host returns 200 text/html instead of a zip', async () => {
    const state = createState();
    const emitted = [];
    const html = new TextEncoder().encode('<html></html>');
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(html, { contentType: 'text/html; charset=utf-8' }),
      emit: msg => emitted.push(msg),
    });
    expect(emitted).toEqual([{ type: 'error', source: 'shs', code: 'local-server-unavailable' }]);
  });

  it('passes a safe proxy code through without proxy details', async () => {
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(new Uint8Array(0), {
        ok: false, status: 502,
        jsonBody: { code: 'application-not-found' },
      }),
      emit: msg => emitted.push(msg),
    });
    expect(emitted).toEqual([{ type: 'error', source: 'shs', code: 'application-not-found' }]);
  });

  it('emits local-server-unavailable when the proxy fetch rejects', async () => {
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
      emit: msg => emitted.push(msg),
    });
    expect(emitted).toEqual([{ type: 'error', source: 'shs', code: 'local-server-unavailable' }]);
  });

  it('emits invalid-event-log for a malformed download', async () => {
    const state = createState();
    const emitted = [];
    await runParseFromUrl(validRequest, state, {
      fetchImpl: fakeFetchReturning(new Uint8Array([1, 2, 3, 4])),
      emit: msg => emitted.push(msg),
    });
    expect(emitted).toEqual([
      { type: 'progress', pct: 0.5, linesProcessed: 0 },
      { type: 'error', source: 'shs', code: 'invalid-event-log', message: expect.stringMatching(/^Could not read the zip archive/) },
    ]);
  });
});

describe('decodeShsArchive', () => {
  it('decodes a valid zip into app/done messages', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"t","Timestamp":0}\n'
      + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n';
    const zipBytes = zipSync({ 'eventlog': strToU8(ndjson) });
    const state = createState();
    const messages = [];
    await decodeShsArchive(zipBytes, state, (msg) => messages.push(msg));
    const appMsg = messages.find((m) => m.type === 'app');
    const doneMsg = messages.find((m) => m.type === 'done');
    expect(appMsg.data.id).toBe('app-1');
    expect(doneMsg.skippedLines).toBe(0);
  });

  // shs-load.ts passes the Node-native zstd decoder; the browser's call leaves fzstd in place.
  it('decodes a zstd entry through an injected zstdDecoder', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-z","App Name":"t","Timestamp":0}\n'
      + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n';
    const zipBytes = zipSync({ 'eventlog.zstd': zstdSync(strToU8(ndjson)) });
    let built = 0;
    const zstdDecoder = (onChunk) => {
      built++;
      return { push: (chunk) => onChunk(new Uint8Array(zstdDecompressSync(chunk))) };
    };
    const messages = [];
    await decodeShsArchive(zipBytes, createState(), (msg) => messages.push(msg), { zstdDecoder });
    expect(built).toBe(1);
    expect(messages.find((m) => m.type === 'app').data.id).toBe('app-z');
  });

  it('emits invalid-event-log on a corrupt zip', async () => {
    const state = createState();
    const messages = [];
    await decodeShsArchive(new Uint8Array([1, 2, 3, 4]), state, (msg) => messages.push(msg));
    expect(messages).toEqual([{ type: 'error', source: 'shs', code: 'invalid-event-log', message: expect.stringMatching(/^Could not read the zip archive/) }]);
  });
});

// The History Server's download (its UI link, or GET /api/v1/applications/<id>/logs) is
// written by Java's ZipOutputStream; historyServerZip mirrors it (deflate, data descriptors).
// Every expectation compares against parsing the same public corpus log unzipped.
describe('History Server zip archives', () => {
  const appId = 'application_0000000000000_0001';
  const sample = new Uint8Array(gunzipSync(readFileSync(fileURLToPath(new URL('../../../public/sample-runs/sample-run.ndjson.gz', import.meta.url)))));
  const withoutProgress = (messages) => messages.filter((m) => m.type !== 'progress');

  async function parse(file, opts = {}) {
    const emitted = [];
    await runParse(file, createState(), { emit: (m) => emitted.push(m), ...opts });
    return emitted;
  }

  // Splits the log into 11 zstd parts at fixed byte offsets (so parts end mid-line) and
  // stores them under the rolling directory in lexicographic order, the order a History
  // Server listing yields: events_10 and events_11 come before events_2.
  function rollingEntries() {
    const parts = 11;
    const step = Math.ceil(sample.length / parts);
    const files = {};
    for (let i = 1; i <= parts; i++) files[`events_${i}_${appId}.zstd`] = zstdSync(sample.subarray((i - 1) * step, i * step));
    files[`appstatus_${appId}`] = new Uint8Array(0);
    const entries = { [`eventlog_v2_${appId}/`]: new Uint8Array(0) };
    for (const name of Object.keys(files).sort()) entries[`eventlog_v2_${appId}/${name}`] = files[name];
    return entries;
  }

  let expected;
  beforeAll(async () => {
    expected = withoutProgress(await parse(fakeFile(sample)));
    expect(expected.some((m) => m.type === 'done')).toBe(true);
  });

  it('builds fixtures in the History Server format: deflated, sizes in a data descriptor', async () => {
    const zip = historyServerZip(rollingEntries());
    const entries = await listZipEntries(fakeFile(zip));
    expect(entries).toHaveLength(13);
    for (const entry of entries) {
      expect(entry.compression).toBe(8);
      const generalPurposeFlags = zip[entry.localHeaderOffset + 6];
      expect(generalPurposeFlags & 0x08).toBe(0x08);
    }
  });

  it('runParse unwraps a single-entry zip', async () => {
    const zip = historyServerZip({ [`${appId}.zstd`]: zstdSync(sample) });
    const emitted = await parse(fakeFile(zip, `${appId}.zip`));
    expect(withoutProgress(emitted)).toEqual(expected);
    const pcts = emitted.filter((m) => m.type === 'progress').map((m) => m.pct);
    expect(pcts.length).toBeGreaterThan(0);
    expect(pcts.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('runParse reassembles a rolling zip in index order, across mid-line part boundaries', async () => {
    const zip = historyServerZip(rollingEntries());
    // A small chunk size streams every entry through many inflate pushes.
    expect(withoutProgress(await parse(fakeFile(zip, `${appId}.zip`), { chunkSize: 4096 }))).toEqual(expected);
  });

  it('runParse awaits an asynchronous zstd decoder', async () => {
    const zip = historyServerZip(rollingEntries());
    const zstdDecoder = (onChunk) => {
      const pending = [];
      return {
        async push(chunk, final) {
          pending.push(chunk.slice());
          if (!final) return;
          await new Promise((r) => setTimeout(r, 0));
          const joined = new Uint8Array(pending.reduce((n, c) => n + c.length, 0));
          let offset = 0;
          for (const c of pending) { joined.set(c, offset); offset += c.length; }
          onChunk(new Uint8Array(zstdDecompressSync(joined)));
        },
      };
    };
    expect(withoutProgress(await parse(fakeFile(zip), { zstdDecoder, chunkSize: 4096 }))).toEqual(expected);
  });

  it('decodeShsArchive reassembles a rolling zip under the eventlog_v2_ directory', async () => {
    const messages = [];
    await decodeShsArchive(historyServerZip(rollingEntries()), createState(), (m) => messages.push(m));
    expect(withoutProgress(messages)).toEqual(expected);
  });

  it('reports a rolling zip with a missing part', async () => {
    const entries = rollingEntries();
    delete entries[`eventlog_v2_${appId}/events_3_${appId}.zstd`];
    const emitted = await parse(fakeFile(historyServerZip(entries)));
    expect(emitted.at(-1)).toEqual({ type: 'error', message: expect.stringMatching(/missing file\(s\) between index 2 and 4/) });
  });

  it('reports a zip entry whose compressed data is corrupt', async () => {
    const zip = historyServerZip({ [`${appId}.zstd`]: zstdSync(sample) });
    const [entry] = await listZipEntries(fakeFile(zip));
    zip.fill(0xff, entry.localHeaderOffset + 100, entry.localHeaderOffset + 200);
    const emitted = await parse(fakeFile(zip));
    expect(emitted.at(-1)).toEqual({ type: 'error', message: expect.stringMatching(/^Could not decompress ".*\.zstd" in the zip archive/) });
  });

  it('reports a truncated zip', async () => {
    const zip = historyServerZip({ [`${appId}.zstd`]: zstdSync(sample) });
    const emitted = await parse(fakeFile(zip.subarray(0, zip.length - 30)));
    expect(emitted).toEqual([{ type: 'error', message: expect.stringMatching(/^Could not read the zip archive/) }]);
  });

  const multiAttemptError = /^The zip archive holds 2 application attempts\. Download a single attempt, for example GET \/api\/v1\/applications\/<appId>\/<attemptId>\/logs\.$/;

  it('rejects a zip holding two single-file attempts', async () => {
    const zip = historyServerZip({
      [`${appId}_1.zstd`]: zstdSync(sample),
      [`${appId}_2.zstd`]: zstdSync(sample),
    });
    const emitted = await parse(fakeFile(zip, `${appId}.zip`));
    expect(emitted).toEqual([{ type: 'error', message: expect.stringMatching(multiAttemptError) }]);
  });

  it('rejects a zip holding two rolling attempts', async () => {
    const entries = {};
    for (const attempt of [1, 2]) {
      const dir = `eventlog_v2_${appId}_${attempt}/`;
      entries[dir] = new Uint8Array(0);
      entries[`${dir}appstatus_${appId}_${attempt}`] = new Uint8Array(0);
      entries[`${dir}events_1_${appId}_${attempt}.zstd`] = zstdSync(sample);
    }
    const zip = historyServerZip(entries);
    const emitted = await parse(fakeFile(zip, `${appId}.zip`));
    expect(emitted).toEqual([{ type: 'error', message: expect.stringMatching(multiAttemptError) }]);
    const messages = [];
    await decodeShsArchive(zip, createState(), (m) => messages.push(m));
    expect(messages).toEqual([{ type: 'error', source: 'shs', code: 'invalid-event-log', message: expect.stringMatching(multiAttemptError) }]);
  });

  it('reports a zip that holds only a directory entry', async () => {
    const emitted = await parse(fakeFile(historyServerZip({ [`eventlog_v2_${appId}/`]: new Uint8Array(0) })));
    expect(emitted).toEqual([{ type: 'error', message: 'The zip archive contains no event log.' }]);
  });

  it('reports a zip that holds no Spark event log', async () => {
    const emitted = await parse(fakeFile(historyServerZip({ 'notes.txt': strToU8('not an event log\n') })));
    expect(emitted.at(-1)).toEqual({ type: 'error', message: expect.stringMatching(/^Not a Spark event log/) });
  });

  // A one-entry stored zip in zip64 form, as ZipOutputStream writes one past 4 GiB: every
  // 32-bit size/offset field is 0xFFFFFFFF and the real values sit in zip64 records. The
  // central directory's extra area puts an unrelated field before the zip64 one.
  function zip64Archive(name, data) {
    const nameBytes = strToU8(name);
    const localExtra = 20, centralExtra = 9 + 28;
    const localSize = 30 + nameBytes.length + localExtra;
    const cdOffset = localSize + data.length, cdSize = 46 + nameBytes.length + centralExtra;
    const zip64EocdOffset = cdOffset + cdSize;
    const out = new Uint8Array(zip64EocdOffset + 56 + 20 + 22);
    const v = new DataView(out.buffer);
    const u64 = (at, n) => { v.setUint32(at, n % 2 ** 32, true); v.setUint32(at + 4, Math.floor(n / 2 ** 32), true); };
    v.setUint32(0, 0x04034b50, true);
    v.setUint32(18, 0xffffffff, true); v.setUint32(22, 0xffffffff, true);
    v.setUint16(26, nameBytes.length, true); v.setUint16(28, localExtra, true);
    out.set(nameBytes, 30);
    let p = 30 + nameBytes.length;
    v.setUint16(p, 0x0001, true); v.setUint16(p + 2, 16, true); u64(p + 4, data.length); u64(p + 12, data.length);
    out.set(data, localSize);
    p = cdOffset;
    v.setUint32(p, 0x02014b50, true);
    v.setUint32(p + 20, 0xffffffff, true); v.setUint32(p + 24, 0xffffffff, true);
    v.setUint16(p + 28, nameBytes.length, true); v.setUint16(p + 30, centralExtra, true);
    v.setUint32(p + 42, 0xffffffff, true);
    out.set(nameBytes, p + 46);
    p += 46 + nameBytes.length;
    v.setUint16(p, 0x5455, true); v.setUint16(p + 2, 5, true);
    p += 9;
    v.setUint16(p, 0x0001, true); v.setUint16(p + 2, 24, true); u64(p + 4, data.length); u64(p + 12, data.length); u64(p + 20, 0);
    p = zip64EocdOffset;
    v.setUint32(p, 0x06064b50, true); u64(p + 4, 44); u64(p + 24, 1); u64(p + 32, 1); u64(p + 40, cdSize); u64(p + 48, cdOffset);
    p += 56;
    v.setUint32(p, 0x07064b50, true); u64(p + 8, zip64EocdOffset); v.setUint32(p + 16, 1, true);
    p += 20;
    v.setUint32(p, 0x06054b50, true);
    v.setUint16(p + 8, 0xffff, true); v.setUint16(p + 10, 0xffff, true);
    v.setUint32(p + 12, 0xffffffff, true); v.setUint32(p + 16, 0xffffffff, true);
    return out;
  }

  it('reads sizes and offsets from zip64 records', async () => {
    const data = zstdSync(sample);
    const zip = zip64Archive(`${appId}.zstd`, data);
    expect(await listZipEntries(fakeFile(zip))).toEqual([
      { name: `${appId}.zstd`, compression: 0, compressedSize: data.length, localHeaderOffset: 0 },
    ]);
    expect(withoutProgress(await parse(fakeFile(zip, `${appId}.zip`)))).toEqual(expected);
  });

  it('reports a zip64 locator that points at no zip64 record', async () => {
    const zip = zip64Archive(`${appId}.zstd`, zstdSync(sample));
    const locator = zip.length - 22 - 20;
    new DataView(zip.buffer).setUint32(locator + 8, 0, true);
    const emitted = await parse(fakeFile(zip));
    expect(emitted).toEqual([{ type: 'error', message: 'Could not read the zip archive: bad zip64 end-of-central-directory record' }]);
  });

  it('reports an entry with an unsupported compression method', async () => {
    const zip = historyServerZip({ [`${appId}.zstd`]: zstdSync(sample) });
    const [entry] = await listZipEntries(fakeFile(zip));
    const view = new DataView(zip.buffer, zip.byteOffset);
    const cdStart = view.getUint32(zip.length - 22 + 16, true);
    view.setUint16(cdStart + 10, 12, true);
    view.setUint16(entry.localHeaderOffset + 8, 12, true);
    const emitted = await parse(fakeFile(zip));
    expect(emitted.at(-1)).toEqual({ type: 'error', message: `Could not decompress "${appId}.zstd" in the zip archive: "${appId}.zstd" uses unsupported zip compression method 12` });
  });

  it('reports a rolling part whose local header is missing', async () => {
    const zip = historyServerZip(rollingEntries());
    const part = (await listZipEntries(fakeFile(zip))).find((e) => e.name.includes('/events_1_'));
    zip[part.localHeaderOffset + 3] = 0;
    const emitted = await parse(fakeFile(zip));
    expect(emitted.at(-1)).toEqual({ type: 'error', message: `Could not decompress "${part.name}" in the zip archive: bad local header for "${part.name}"` });
  });
});

describe('naturalCompare', () => {
  it('sorts rolling-log entry names numerically, not lexicographically', () => {
    const names = ['events_10', 'events_2', 'events_1'];
    expect(names.sort(naturalCompare)).toEqual(['events_1', 'events_2', 'events_10']);
  });
});

describe('reassembleRollingEntries', () => {
  it('sorts events_<n>_... names in ascending numeric order (not lexicographic)', () => {
    // Contiguous 9/10/11 on purpose: lexicographic sort would wrongly put
    // "events_10_app" and "events_11_app" before "events_9_app" ('1' < '9').
    const names = ['events_11_app', 'events_9_app', 'events_10_app'];
    expect(reassembleRollingEntries(names)).toEqual(['events_9_app', 'events_10_app', 'events_11_app']);
  });

  it('drops the appstatus_* completion marker', () => {
    const names = ['events_1_app', 'appstatus_app', 'events_2_app'];
    expect(reassembleRollingEntries(names)).toEqual(['events_1_app', 'events_2_app']);
  });

  it('drops the .inprogress appstatus marker too', () => {
    const names = ['events_1_app', 'appstatus_app.inprogress'];
    expect(reassembleRollingEntries(names)).toEqual(['events_1_app']);
  });

  it('drops events_* files at or below the highest .compact index, keeping the .compact file itself', () => {
    const names = ['events_1_app', 'events_2_app', 'events_2_app.compact', 'events_3_app', 'events_4_app'];
    expect(reassembleRollingEntries(names)).toEqual(['events_2_app.compact', 'events_3_app', 'events_4_app']);
  });

  it('keeps only the highest-indexed .compact file when more than one is present', () => {
    const names = ['events_1_app.compact', 'events_3_app.compact', 'events_4_app'];
    expect(reassembleRollingEntries(names)).toEqual(['events_3_app.compact', 'events_4_app']);
  });

  it('throws on a non-contiguous index gap', () => {
    const names = ['events_1_app', 'events_2_app', 'events_4_app'];
    expect(() => reassembleRollingEntries(names)).toThrow(/missing/i);
  });

  it('ignores unrelated filenames that are neither appstatus_* nor events_<n>_*', () => {
    const names = ['events_1_app', 'events_2_app', '.DS_Store'];
    expect(reassembleRollingEntries(names)).toEqual(['events_1_app', 'events_2_app']);
  });
});

describe('accumulateTask: task-attempt dedup', () => {
  function setupStage(s, id = 1) {
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': id, 'Submission Time': 0 },
    }, s);
  }

  function taskEnd(stageId, attemptId, index, { launch, finish, failed = false, shuffleRead = 0 }) {
    return {
      Event: 'SparkListenerTaskEnd', 'Stage ID': stageId, 'Stage Attempt ID': attemptId,
      'Task Info': { 'Index': index, 'Attempt': 0, 'Launch Time': launch, 'Finish Time': finish, 'Failed': failed, 'Killed': false },
      'Task End Reason': failed ? { Reason: 'FetchFailed' } : undefined,
      'Task Metrics': {
        'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0, 'Executor Run Time': finish - launch,
        'Shuffle Read Metrics': { 'Remote Bytes Read': shuffleRead, 'Local Bytes Read': 0, 'Fetch Wait Time': 0 },
        'Shuffle Write Metrics': { 'Shuffle Bytes Written': 0 },
        'Input Metrics': { 'Bytes Read': 0 }, 'Output Metrics': { 'Bytes Written': 0 },
      },
    };
  }

  it('counts a failed-then-successful retry as one task, not two', () => {
    const s = createState();
    setupStage(s);
    processEvent(taskEnd(1, 0, 0, { launch: 0, finish: 100, failed: true, shuffleRead: 500 }), s);
    processEvent(taskEnd(1, 0, 0, { launch: 100, finish: 250, failed: false, shuffleRead: 800 }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 300 } }, s);

    expect(msg.data.taskCount).toBe(1);
    expect(msg.data.failedTasks).toBe(0);
    expect(msg.data.shuffleReadBytes).toBe(800);
    expect(msg.data.retryWasteMs).toBe(100);
    expect(msg.data.wastedAttempts).toBe(1);
  });

  it('does not dedupe distinct task indices', () => {
    const s = createState();
    setupStage(s);
    processEvent(taskEnd(1, 0, 0, { launch: 0, finish: 100 }), s);
    processEvent(taskEnd(1, 0, 1, { launch: 0, finish: 150 }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.taskCount).toBe(2);
    expect(msg.data.retryWasteMs).toBe(0);
  });

  it('falls back to no dedup when Task Info.Index is absent (legacy fixture shape)', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100 },
      'Task Metrics': {},
    }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100 },
      'Task Metrics': {},
    }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.taskCount).toBe(2);
  });

  it('does not crash on a TaskEnd that arrives after the stage already completed', () => {
    const s = createState();
    setupStage(s);
    processEvent(taskEnd(1, 0, 0, { launch: 0, finish: 100 }), s);
    processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);

    expect(() => processEvent(taskEnd(1, 0, 1, { launch: 100, finish: 250 }), s)).not.toThrow();
  });
});

describe('accumulateTask: retry vs. speculation waste classification', () => {
  function setupStage(s, id = 1) {
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': id, 'Submission Time': 0 },
    }, s);
  }

  function specTaskEnd(stageId, index, { launch, finish, failed = false, killed = false, speculative = false, taskId = index, attemptNumber = 0 }) {
    return {
      Event: 'SparkListenerTaskEnd', 'Stage ID': stageId, 'Stage Attempt ID': 0,
      'Task Info': {
        'Index': index, 'Attempt': 0, 'Task ID': taskId, 'Attempt Number': attemptNumber,
        'Launch Time': launch, 'Finish Time': finish,
        'Failed': failed, 'Killed': killed, 'Speculative': speculative,
      },
      'Task End Reason': (failed || killed) ? { Reason: killed ? 'TaskKilled' : 'FetchFailed' } : undefined,
      'Task Metrics': {
        'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0, 'Executor Run Time': finish - launch,
        'Shuffle Read Metrics': { 'Remote Bytes Read': 0, 'Local Bytes Read': 0, 'Fetch Wait Time': 0 },
        'Shuffle Write Metrics': { 'Shuffle Bytes Written': 0 },
        'Input Metrics': { 'Bytes Read': 0 }, 'Output Metrics': { 'Bytes Written': 0 },
      },
    };
  }

  it('attributes waste to speculation when the losing attempt is the speculative copy', () => {
    const s = createState();
    setupStage(s);
    // Original wins first (non-speculative, succeeds)...
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100, speculative: false }), s);
    // ...speculative copy arrives later, killed because it lost the race.
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 120, killed: true, speculative: true }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);

    expect(msg.data.speculationWasteMs).toBe(120);
    expect(msg.data.speculationWastedAttempts).toBe(1);
    expect(msg.data.retryWasteMs).toBe(0);
    expect(msg.data.wastedAttempts).toBe(0);
  });

  it('attributes waste to speculation when the winning attempt is the speculative copy', () => {
    const s = createState();
    setupStage(s);
    // Speculative copy launches and wins (finishes first)...
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100, speculative: true }), s);
    // ...original attempt is slow and arrives later, killed because it lost
    // the race; its own `speculative` flag is false, but the *winner*
    // (existing, already recorded) is speculative, so this must still
    // classify as speculation waste.
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 500, killed: true, speculative: false }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 600 } }, s);

    expect(msg.data.speculationWasteMs).toBe(500);
    expect(msg.data.speculationWastedAttempts).toBe(1);
    expect(msg.data.retryWasteMs).toBe(0);
  });

  it('attributes waste to a genuine failure-retry when neither attempt is speculative', () => {
    const s = createState();
    setupStage(s);
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100, failed: true, speculative: false }), s);
    processEvent(specTaskEnd(1, 0, { launch: 100, finish: 250, speculative: false }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 300 } }, s);

    expect(msg.data.retryWasteMs).toBe(100);
    expect(msg.data.wastedAttempts).toBe(1);
    expect(msg.data.speculationWasteMs).toBe(0);
    expect(msg.data.speculationWastedAttempts).toBe(0);
  });

  it('attributes waste to a double non-speculative failure as a retry, not speculation', () => {
    const s = createState();
    setupStage(s);
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100, failed: true, speculative: false }), s);
    processEvent(specTaskEnd(1, 0, { launch: 100, finish: 180, failed: true, speculative: false }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 300 } }, s);

    expect(msg.data.retryWasteMs).toBe(80);
    expect(msg.data.speculationWasteMs).toBe(0);
  });

  it('captures the discarded failed attempt in retryTaskSamples on a genuine retry', () => {
    const s = createState();
    setupStage(s);
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100, failed: true, speculative: false, taskId: 7, attemptNumber: 0 }), s);
    processEvent(specTaskEnd(1, 0, { launch: 100, finish: 250, speculative: false, taskId: 7, attemptNumber: 1 }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 300 } }, s);

    expect(msg.data.retryTaskSamples).toHaveLength(1);
    expect(msg.data.retryTaskSamples[0]).toMatchObject({ taskId: 7, attemptNumber: 0, reason: 'FetchFailed' });
  });

  it('captures the discarded losing duplicate in retryTaskSamples on a non-winning duplicate', () => {
    const s = createState();
    setupStage(s);
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100, failed: true, speculative: false, taskId: 9, attemptNumber: 0 }), s);
    processEvent(specTaskEnd(1, 0, { launch: 100, finish: 180, failed: true, speculative: false, taskId: 9, attemptNumber: 1 }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 300 } }, s);

    expect(msg.data.retryTaskSamples).toHaveLength(1);
    expect(msg.data.retryTaskSamples[0]).toMatchObject({ taskId: 9, attemptNumber: 1 });
  });

  // Spark kills a losing speculative copy only once its stage finishes ("Stage cancelled: Stage
  // finished"), so the loser's TaskEnd lands after StageCompleted has already finalized the stage.
  describe('late TaskEnd after StageCompleted', () => {
    // emitParseCompletion posts the final app message, so the run needs an ApplicationStart.
    function startRun() {
      const s = createState();
      processEvent({ Event: 'SparkListenerApplicationStart', 'App ID': 'application_0000000000000_0001', 'App Name': 't', Timestamp: 0 }, s);
      setupStage(s);
      return s;
    }
    const complete = (s, at) => processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': at } }, s);
    // Collects the pre-done patch messages into an appModel holding the stage message posted at completion.
    function finishParse(s, stageMsg) {
      const appModel = { app: null, stages: new Map([[1, stageMsg.data]]), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map() };
      const cb = createModelCallbacks(appModel, {});
      emitParseCompletion(s, (m) => routeMessage(m, cb), 0);
      return appModel;
    }

    it('counts a late killed speculative copy as speculation waste, and nothing else', () => {
      const s = startRun();
      processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100 }), s);
      const stageMsg = complete(s, 100);
      processEvent(specTaskEnd(1, 0, { launch: 10, finish: 130, killed: true, speculative: true, taskId: 5, attemptNumber: 1 }), s);

      const stage = finishParse(s, stageMsg).stages.get(1);
      expect(stage).toMatchObject({ speculationWasteMs: 120, speculationWastedAttempts: 1 });
      // Every other late-attempt stat stays excluded.
      expect(stage).toMatchObject({ taskCount: 1, failedTasks: 0, speculativeTasks: 0, retryWasteMs: 0, wastedAttempts: 0, executorRunTime: 100 });
      expect(s.evidenceInputs.taskRecords).toBe(1);
    });

    it('counts a late killed original whose speculative copy already won', () => {
      const s = startRun();
      processEvent(specTaskEnd(1, 0, { launch: 50, finish: 100, speculative: true, taskId: 5, attemptNumber: 1 }), s);
      const stageMsg = complete(s, 100);
      processEvent(specTaskEnd(1, 0, { launch: 0, finish: 400, killed: true }), s);

      expect(finishParse(s, stageMsg).stages.get(1)).toMatchObject({ speculationWasteMs: 400, speculationWastedAttempts: 1 });
    });

    it('ignores a late non-speculative attempt that raced no speculative copy', () => {
      const s = startRun();
      processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100 }), s);
      const stageMsg = complete(s, 100);
      processEvent(specTaskEnd(1, 0, { launch: 0, finish: 300, killed: true, taskId: 6, attemptNumber: 1 }), s);

      expect(finishParse(s, stageMsg).stages.get(1)).toMatchObject({ speculationWasteMs: 0, speculationWastedAttempts: 0, retryWasteMs: 0 });
    });

    it('ignores a late TaskEnd without Task Info, which cannot be paired to a task', () => {
      const s = startRun();
      processEvent(specTaskEnd(1, 0, { launch: 50, finish: 100, speculative: true }), s);
      const stageMsg = complete(s, 100);
      processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0 }, s);

      expect(finishParse(s, stageMsg).stages.get(1)).toMatchObject({ speculationWasteMs: 0, speculationWastedAttempts: 0 });
    });

    it('keeps the pairing state out of the posted stage message', () => {
      const s = startRun();
      processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100, speculative: true }), s);
      const stageMsg = complete(s, 100);
      expect(stageMsg.data).not.toHaveProperty('speculativeWinners');
      expect(stageMsg.data).not.toHaveProperty('lateSpeculationWaste');
    });

    it('lets speculationWaste fire on losers that all end after StageCompleted', () => {
      const s = startRun();
      for (let i = 0; i < 6; i++) processEvent(specTaskEnd(1, i, { launch: 0, finish: 1000, taskId: i }), s);
      const stageMsg = complete(s, 1000);
      // Six losing copies, 21.5 s each: 129 s total, over the 5-attempt, 60 s floor.
      for (let i = 0; i < 6; i++) {
        processEvent(specTaskEnd(1, i, { launch: 500, finish: 22000, killed: true, speculative: true, taskId: 100 + i, attemptNumber: 1 }), s);
      }
      expect(analyze(null, new Map([[1, stageMsg.data]]), [], []).some((f) => f.type === 'speculationWaste')).toBe(false);

      const appModel = finishParse(s, stageMsg);
      const finding = analyze(null, appModel.stages, [], []).find((f) => f.type === 'speculationWaste');
      expect(finding).toMatchObject({ stageId: 1, value: 129000 });
    });
  });

  it('does not add a speculative retry to retryTaskSamples', () => {
    const s = createState();
    setupStage(s);
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 100, speculative: false, taskId: 3 }), s);
    processEvent(specTaskEnd(1, 0, { launch: 0, finish: 120, killed: true, speculative: true, taskId: 3 }), s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);

    expect(msg.data.retryTaskSamples).toHaveLength(0);
  });

  it('caps retryTaskSamples at 20 even with more discarded attempts', () => {
    const s = createState();
    setupStage(s);
    for (let i = 0; i < 25; i++) {
      processEvent(specTaskEnd(1, i, { launch: 0, finish: 100, failed: true, speculative: false, taskId: i, attemptNumber: 0 }), s);
      processEvent(specTaskEnd(1, i, { launch: 100, finish: 200, speculative: false, taskId: i, attemptNumber: 1 }), s);
    }
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 300 } }, s);

    expect(msg.data.wastedAttempts).toBe(25);
    expect(msg.data.retryTaskSamples).toHaveLength(20);
  });
});

describe('finalizeStage: failedTaskSamples', () => {
  function stageEnd(id, extra = {}) {
    return { Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': id, 'Completion Time': 300, ...extra } };
  }

  it('collects a surviving failed task into failedTaskSamples', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task End Reason': { Reason: 'ExecutorLostFailure' },
      'Task Info': { Index: 0, 'Task ID': 11, 'Attempt Number': 0, 'Launch Time': 0, 'Finish Time': 100, Failed: true, Host: 'h1', 'Executor ID': 'e1' },
      'Task Metrics': { 'Peak Execution Memory': 500, 'Memory Bytes Spilled': 0, 'Shuffle Write Metrics': { 'Shuffle Bytes Written': 0 } },
    }, s);
    const msg = processEvent(stageEnd(1, { 'Failure Reason': 'Job aborted due to stage failure' }), s);

    expect(msg.data.failedTaskSamples).toHaveLength(1);
    expect(msg.data.failedTaskSamples[0]).toMatchObject({ taskId: 11, attemptNumber: 0, host: 'h1', executorId: 'e1', reason: 'ExecutorLostFailure' });
  });

  it('does not collect a task that ultimately succeeded', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { Index: 0, 'Task ID': 1, 'Launch Time': 0, 'Finish Time': 100, Failed: false },
      'Task Metrics': {},
    }, s);
    const msg = processEvent(stageEnd(1), s);
    expect(msg.data.failedTaskSamples).toHaveLength(0);
  });

  it('caps failedTaskSamples at 20', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    for (let i = 0; i < 25; i++) {
      processEvent({
        Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
        'Task End Reason': { Reason: 'ExecutorLostFailure' },
        'Task Info': { Index: i, 'Task ID': i, 'Launch Time': 0, 'Finish Time': 100, Failed: true },
        'Task Metrics': {},
      }, s);
    }
    const msg = processEvent(stageEnd(1), s);
    expect(msg.data.failedTasks).toBe(25);
    expect(msg.data.failedTaskSamples).toHaveLength(20);
  });
});

describe('finalizeStage: failureGroups', () => {
  function failedEnd(index, endReason, extraInfo = {}) {
    return {
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task End Reason': endReason,
      'Task Info': { Index: index, 'Task ID': index, 'Launch Time': 0, 'Finish Time': 100, Failed: true, ...extraInfo },
      'Task Metrics': {},
    };
  }
  const exception = (description) => ({
    Reason: 'ExceptionFailure', 'Class Name': 'java.lang.IllegalStateException', Description: description,
    'Full Stack Trace': `java.lang.IllegalStateException: ${description}\n\tat com.example.Job.run(Job.scala:10)`,
  });
  function runStage(events) {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    for (const e of events) processEvent(e, s);
    return processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 300 } }, s).data;
  }

  it('groups surviving failed tasks by distinct error, most frequent first, one excerpt each', () => {
    const lost = { Reason: 'ExecutorLostFailure', 'Executor ID': '3', 'Loss Reason': 'Container killed by YARN for exceeding memory limits.' };
    const data = runStage([
      failedEnd(0, lost), failedEnd(1, exception('bad row')), failedEnd(2, lost), failedEnd(3, lost),
    ]);
    expect(data.failureGroups).toEqual([
      { reason: 'ExecutorLostFailure', className: null, message: null, lossReason: 'Container killed by YARN for exceeding memory limits.', stackExcerpt: null, count: 3 },
      {
        reason: 'ExceptionFailure', className: 'java.lang.IllegalStateException', message: 'bad row', lossReason: null,
        stackExcerpt: 'java.lang.IllegalStateException: bad row\n\tat com.example.Job.run(Job.scala:10)', count: 1,
      },
    ]);
    expect(data).not.toHaveProperty('failureDetails');
  });

  it('keeps a failed attempt that a retry later won out of the groups', () => {
    const data = runStage([
      failedEnd(0, exception('transient')),
      { Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Task Info': { Index: 0, 'Task ID': 9, 'Launch Time': 100, 'Finish Time': 200 }, 'Task Metrics': {} },
    ]);
    expect(data.failureGroups).toEqual([]);
  });

  it('stops adding distinct errors at 50 per stage; later ones still count as failed tasks', () => {
    const data = runStage(Array.from({ length: 60 }, (_, i) => failedEnd(i, exception(`value ${i}`))));
    expect(data.failedTasks).toBe(60);
    expect(data.failureGroups).toHaveLength(50);
  });

  it('ignores a non-string end-reason field instead of dropping the task', () => {
    const data = runStage([failedEnd(0, { Reason: 'ExceptionFailure', 'Class Name': 42, Description: ['x'] })]);
    expect(data.failedTasks).toBe(1);
    expect(data.failureGroups).toEqual([{ reason: 'ExceptionFailure', className: null, message: null, lossReason: null, stackExcerpt: null, count: 1 }]);
  });
});

describe('accumulateTask: locality', () => {
  it('aggregates locality counts per stage', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Task Info': { 'Index': 0, 'Launch Time': 0, 'Finish Time': 100, 'Locality': 'PROCESS_LOCAL' }, 'Task Metrics': {} }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Task Info': { 'Index': 1, 'Launch Time': 0, 'Finish Time': 100, 'Locality': 'PROCESS_LOCAL' }, 'Task Metrics': {} }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Task Info': { 'Index': 2, 'Launch Time': 0, 'Finish Time': 100, 'Locality': 'RACK_LOCAL' }, 'Task Metrics': {} }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    const stats = Object.fromEntries(msg.data.localityStats.map(l => [l.locality, l.count]));
    expect(stats.PROCESS_LOCAL).toBe(2);
    expect(stats.RACK_LOCAL).toBe(1);
  });
});

describe('accumulateTask: peak execution memory', () => {
  it('tracks the max peak execution memory across tasks in a stage', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Task Info': { 'Index': 0, 'Launch Time': 0, 'Finish Time': 100 }, 'Task Metrics': { 'Peak Execution Memory': 1000 } }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Task Info': { 'Index': 1, 'Launch Time': 0, 'Finish Time': 100 }, 'Task Metrics': { 'Peak Execution Memory': 5000 } }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.peakExecutionMemoryMax).toBe(5000);
  });

  it('defaults to 0 when the field is absent', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Task Info': { 'Index': 0, 'Launch Time': 0, 'Finish Time': 100 }, 'Task Metrics': {} }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.peakExecutionMemoryMax).toBe(0);
  });
});

describe('parseSparkMemoryMB', () => {
  it('treats a bare number as MiB (Spark bytesConf(MiB) default)', () => {
    expect(parseSparkMemoryMB('2048')).toBe(2048);
    expect(parseSparkMemoryMB('10')).toBe(10);
  });

  it('distinguishes explicit bytes ("10b") from bare MiB ("10")', () => {
    expect(parseSparkMemoryMB('10b')).toBe(0); // 10 bytes → ~0 MiB
    expect(parseSparkMemoryMB('2097152b')).toBe(2); // 2 MiB in bytes
    expect(parseSparkMemoryMB('10')).toBe(10); // MiB
  });

  it('applies k/m/g/t units (trailing "b" redundant)', () => {
    expect(parseSparkMemoryMB('10G')).toBe(10240);
    expect(parseSparkMemoryMB('10gb')).toBe(10240);
    expect(parseSparkMemoryMB('1024k')).toBe(1);
    expect(parseSparkMemoryMB('1t')).toBe(1024 * 1024);
    expect(parseSparkMemoryMB('512m')).toBe(512);
  });

  it('returns null for null or unparseable input', () => {
    expect(parseSparkMemoryMB(null)).toBeNull();
    expect(parseSparkMemoryMB('abc')).toBeNull();
  });
});

describe('processEvent: EnvironmentUpdate / config + resources', () => {
  const envEvent = {
    Event: 'SparkListenerEnvironmentUpdate',
    'Spark Properties': {
      'spark.executor.memory': '10G',
      'spark.executor.cores': '5',
      'spark.executor.instances': '2',
      'spark.executor.memoryOverhead': '2048',
      'spark.driver.memory': '30g',
      'spark.driver.cores': '12',
      'spark.driver.memoryOverhead': '400',
      'spark.serializer': 'org.apache.spark.serializer.KryoSerializer',
      'spark.dynamicAllocation.enabled': 'true',
      'spark.shuffle.service.enabled': 'true',
    },
  };
  const appStart = { Event: 'SparkListenerApplicationStart', 'App ID': 'a', 'App Name': 'n', 'Timestamp': 1 };

  it('stashes config seen before ApplicationStart and applies it to app.config', () => {
    const s = createState();
    expect(processEvent(envEvent, s)).toBeNull();
    const appMsg = processEvent(appStart, s);
    expect(appMsg.data.config['spark.executor.memory']).toBe('10G');
    expect(appMsg.data.config['spark.serializer']).toContain('Kryo');
  });

  it('derives executor/driver resources (memory MB, cores, instances, flags)', () => {
    const s = createState();
    processEvent(envEvent, s);
    const r = processEvent(appStart, s).data.resources;
    expect(r.executor.memoryMB).toBe(10240);
    expect(r.executor.memoryOverheadMB).toBe(2048);
    expect(r.executor.cores).toBe(5);
    expect(r.executor.instances).toBe(2);
    expect(r.driver.memoryMB).toBe(30720);
    expect(r.driver.cores).toBe(12);
    expect(r.driver.memoryOverheadMB).toBe(400);
    expect(r.dynamicAllocationEnabled).toBe(true);
    expect(r.shuffleServiceEnabled).toBe(true);
    expect(r.serializer).toContain('Kryo');
  });

  it('degrades a non-numeric cores/instances value to null instead of NaN', () => {
    const s = createState();
    processEvent({
      Event: 'SparkListenerEnvironmentUpdate',
      'Spark Properties': { 'spark.executor.cores': 'auto', 'spark.executor.instances': 'auto' },
    }, s);
    const r = processEvent(appStart, s).data.resources;
    expect(r.executor.cores).toBeNull();
    expect(r.executor.instances).toBeNull();
  });

  it('handles EnvironmentUpdate arriving after ApplicationStart (emits updated app)', () => {
    const s = createState();
    processEvent(appStart, s);
    const msg = processEvent(envEvent, s);
    expect(msg.type).toBe('app');
    expect(msg.data.config['spark.executor.cores']).toBe('5');
    expect(s.app.resources.executor.memoryMB).toBe(10240);
  });

  it('handles Spark Properties in legacy array-of-pairs form', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerEnvironmentUpdate', 'Spark Properties': [['spark.executor.cores', '3']] }, s);
    const appMsg = processEvent(appStart, s);
    expect(appMsg.data.config['spark.executor.cores']).toBe('3');
    expect(appMsg.data.resources.executor.cores).toBe(3);
  });

  it('app.config defaults to {} and resources fields to null with no EnvironmentUpdate', () => {
    const s = createState();
    const appMsg = processEvent(appStart, s);
    expect(appMsg.data.config).toEqual({});
    expect(appMsg.data.resources.executor.memoryMB).toBeNull();
    expect(appMsg.data.resources.executor.cores).toBeNull();
    expect(appMsg.data.resources.dynamicAllocationEnabled).toBeNull();
  });
});

describe('processEvent: JobStart / JobEnd result capture', () => {
  it('records a job and captures a successful result', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerJobStart', 'Job ID': 0, 'Submission Time': 100, 'Stage IDs': [0, 1], Properties: {} }, s);
    const msg = processEvent({ Event: 'SparkListenerJobEnd', 'Job ID': 0, 'Completion Time': 500, 'Job Result': { Result: 'JobSucceeded' } }, s);
    expect(msg.type).toBe('job');
    expect(msg.data.id).toBe(0);
    expect(msg.data.result).toBe('JobSucceeded');
    expect(msg.data.succeeded).toBe(true);
    expect(msg.data.completionTime).toBe(500);
    expect(msg.data.stageIds).toEqual([0, 1]);
    expect(s.jobs.get(0).succeeded).toBe(true);
  });

  it('captures a failed job result and its exception message', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerJobStart', 'Job ID': 1, 'Submission Time': 100, 'Stage IDs': [2] }, s);
    const msg = processEvent({
      Event: 'SparkListenerJobEnd', 'Job ID': 1, 'Completion Time': 900,
      'Job Result': { Result: 'JobFailed', Exception: { Message: 'boom' } },
    }, s);
    expect(msg.data.result).toBe('JobFailed');
    expect(msg.data.succeeded).toBe(false);
    expect(msg.data.exception).toBe('boom');
  });

  it('handles JobEnd with no preceding JobStart', () => {
    const s = createState();
    const msg = processEvent({ Event: 'SparkListenerJobEnd', 'Job ID': 7, 'Completion Time': 200, 'Job Result': { Result: 'JobSucceeded' } }, s);
    expect(msg.type).toBe('job');
    expect(msg.data.id).toBe(7);
    expect(msg.data.stageIds).toEqual([]);
    expect(msg.data.succeeded).toBe(true);
  });

  it('JobStart still maps stages to the SQL execution (regression)', () => {
    const s = createState();
    processEvent({
      Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart',
      executionId: 10, description: 'x', time: 1, physicalPlanDescription: '',
    }, s);
    processEvent({ Event: 'SparkListenerJobStart', 'Job ID': 3, 'Stage IDs': [18], Properties: { 'spark.sql.execution.id': '10' } }, s);
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 18, 'Submission Time': 1 } }, s);
    expect(s.stages.get(18).sqlExecutionId).toBe(10);
  });
});

describe('startJob: sqlExecStages incremental index', () => {
  it('records the execution\'s stage universe as SparkListenerJobStart events arrive', () => {
    const state = createState();
    processEvent({
      Event: 'SparkListenerJobStart',
      'Job ID': 1, 'Stage IDs': [10, 11],
      Properties: { 'spark.sql.execution.id': '3' },
    }, state);
    processEvent({
      Event: 'SparkListenerJobStart',
      'Job ID': 2, 'Stage IDs': [12],
      Properties: { 'spark.sql.execution.id': '3' },
    }, state);

    expect(state.sqlExecStages.get(3)).toEqual(new Set([10, 11, 12]));
  });

  it('does not create an entry for jobs with no sql.execution.id property', () => {
    const state = createState();
    processEvent({ Event: 'SparkListenerJobStart', 'Job ID': 1, 'Stage IDs': [10] }, state);
    expect(state.sqlExecStages.size).toBe(0);
  });
});

// Stream a (possibly multi-GB) real fixture line-by-line, keeping only lines
// matching one of `substrings`, so tests exercise real shapes without loading
// the whole file into memory.
async function collectMatchingLines(filePath, substrings) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) {
    if (substrings.some(s => line.includes(s))) lines.push(line);
  }
  return lines;
}

// ── Minimal File-like stub for the dropped-file (runParse) path ──────────────
function fakeFile(bytes, name = 'eventlog') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    name,
    size: u8.length,
    slice(start, end) {
      const view = u8.subarray(start, end);
      return { async arrayBuffer() { return view.slice().buffer; } };
    },
    async arrayBuffer() { return u8.slice().buffer; },
  };
}

describe('sniffCodec', () => {
  it('detects gzip by magic bytes', () => {
    expect(sniffCodec(gzipSync(strToU8('x')))).toBe('gz');
  });

  it('detects a Spark LZ4Block stream by magic bytes', () => {
    const header = new Uint8Array(21);
    header.set([76, 90, 52, 66, 108, 111, 99, 107], 0); // "LZ4Block"
    expect(sniffCodec(header)).toBe('lz4');
  });

  it('detects a Zstandard stream by magic bytes', () => {
    expect(sniffCodec(zstdSync(strToU8('x')))).toBe('zstd');
  });

  it('detects a Spark SnappyCodec (xerial) stream by magic bytes', () => {
    const header = new Uint8Array(16);
    header.set([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00], 0);
    expect(sniffCodec(header)).toBe('snappy');
  });

  it('returns null for plain NDJSON', () => {
    expect(sniffCodec(strToU8('{"Event":"x"}'))).toBeNull();
  });
});

describe('SparkListenerStageExecutorMetrics: executor peak/used memory (item B)', () => {
  // Synthetic fixture: no real example log has spark.eventLog.logStageExecutorMetrics=true set.
  const SAMPLE_METRICS = {
    JVMHeapMemory: 111111, JVMOffHeapMemory: 222222,
    OnHeapExecutionMemory: 0, OffHeapExecutionMemory: 0,
    OnHeapStorageMemory: 333333, OffHeapStorageMemory: 0,
    OnHeapUnifiedMemory: 0, OffHeapUnifiedMemory: 0,
    DirectPoolMemory: 0, MappedPoolMemory: 0,
    ProcessTreeJVMVMemory: 0, ProcessTreeJVMRSSMemory: 0,
    ProcessTreePythonVMemory: 0, ProcessTreePythonRSSMemory: 0,
    ProcessTreeOtherVMemory: 0, ProcessTreeOtherRSSMemory: 0,
    MinorGCCount: 5, MinorGCTime: 50,
    MajorGCCount: 1, MajorGCTime: 20, TotalGCTime: 70,
    ConcurrentGCCount: 0, ConcurrentGCTime: 0,
  };
  const EXPECTED_CAMEL = {
    jvmHeapMemory: 111111, jvmOffHeapMemory: 222222,
    onHeapExecutionMemory: 0, offHeapExecutionMemory: 0,
    onHeapStorageMemory: 333333, offHeapStorageMemory: 0,
    onHeapUnifiedMemory: 0, offHeapUnifiedMemory: 0,
    directPoolMemory: 0, mappedPoolMemory: 0,
    processTreeJVMVMemory: 0, processTreeJVMRSSMemory: 0,
    processTreePythonVMemory: 0, processTreePythonRSSMemory: 0,
    processTreeOtherVMemory: 0, processTreeOtherRSSMemory: 0,
    minorGCCount: 5, minorGCTime: 50,
    majorGCCount: 1, majorGCTime: 20, totalGCTime: 70,
    concurrentGCCount: 0, concurrentGCTime: 0,
  };

  function setupStage(s, id = 1) {
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': id, 'Submission Time': 0 } }, s);
  }

  it('stores executor metrics on the stage, keyed by executor ID, camelCased', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerStageExecutorMetrics',
      'Executor ID': '3', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Executor Metrics': SAMPLE_METRICS,
    }, s);
    expect(s.stages.get(1).executorMetrics.get('3')).toEqual(EXPECTED_CAMEL);
  });

  it('returns null; the event does not itself finalize the stage', () => {
    const s = createState();
    setupStage(s);
    const msg = processEvent({
      Event: 'SparkListenerStageExecutorMetrics',
      'Executor ID': '1', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Executor Metrics': {},
    }, s);
    expect(msg).toBeNull();
    expect(s.evidenceInputs.executorMetricRows).toBe(0);
  });

  it('ignores the event for an unknown stage ID without throwing', () => {
    const s = createState();
    expect(() => processEvent({
      Event: 'SparkListenerStageExecutorMetrics',
      'Executor ID': '1', 'Stage ID': 999, 'Stage Attempt ID': 0,
      'Executor Metrics': { JVMHeapMemory: 1 },
    }, s)).not.toThrow();
  });

  it('ignores unrecognized fields inside Executor Metrics without throwing (forward-compat)', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerStageExecutorMetrics',
      'Executor ID': '1', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Executor Metrics': { JVMHeapMemory: 1, SomeFutureMetricType: 999 },
    }, s);
    expect(s.stages.get(1).executorMetrics.get('1')).toEqual({ jvmHeapMemory: 1 });
  });

  it('survives to the finalized stage message as a Map', () => {
    const s = createState();
    setupStage(s);
    processEvent({
      Event: 'SparkListenerStageExecutorMetrics',
      'Executor ID': '1', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Executor Metrics': { JVMHeapMemory: 42 },
    }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 100 } }, s);
    expect(msg.data.executorMetrics).toBeInstanceOf(Map);
    expect(msg.data.executorMetrics.get('1')).toEqual({ jvmHeapMemory: 42 });
  });

  it('the map stays empty when the event never appears (flag off, the common case)', () => {
    const s = createState();
    setupStage(s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 100 } }, s);
    expect(msg.data.executorMetrics.size).toBe(0);
  });

  // Real Spark ordering: StageCompleted is logged before the per-executor
  // StageExecutorMetrics, so the completion message carries an empty map;
  // metrics are recovered via the pre-done collectStageExecutorMetrics re-post.
  it('recovers metrics that arrive AFTER StageCompleted (the real event order) via collectStageExecutorMetrics', () => {
    const s = createState();
    setupStage(s);
    const stageMsg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 100 } }, s);
    // The posted stage message is empty at completion time; this is the bug the re-post works around.
    expect(stageMsg.data.executorMetrics.size).toBe(0);
    // Metrics arrive afterwards, as in a real log.
    processEvent({
      Event: 'SparkListenerStageExecutorMetrics',
      'Executor ID': '7', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Executor Metrics': { JVMHeapMemory: 99 },
    }, s);
    const collected = collectStageExecutorMetrics(s);
    expect(collected.get(1)).toBeInstanceOf(Map);
    expect(collected.get(1).get('7')).toEqual({ jvmHeapMemory: 99 });
  });

  it('collectStageExecutorMetrics omits stages with no executor metrics (flag off)', () => {
    const s = createState();
    setupStage(s);
    processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 100 } }, s);
    expect(collectStageExecutorMetrics(s).size).toBe(0);
  });
});

// Frame one payload as a single RAW-method (0x10) Spark LZ4Block block.
function lz4RawBlock(payload) {
  const header = new Uint8Array(21);
  header.set([76, 90, 52, 66, 108, 111, 99, 107], 0); // "LZ4Block"
  header[8] = 0x10; // RAW method
  new DataView(header.buffer).setInt32(9, payload.length, true);
  new DataView(header.buffer).setInt32(13, payload.length, true);
  const framed = new Uint8Array(header.length + payload.length);
  framed.set(header, 0);
  framed.set(payload, header.length);
  return framed;
}

// Frame multiple payloads as literal-only blocks inside ONE xerial
// SnappyOutputStream stream (single header, N length-prefixed blocks).
function snappyRawBlocks(payloads) {
  const SNAPPY_MAGIC = [0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00];
  const encodeVarint = (n) => {
    const bytes = [];
    while (n >= 0x80) { bytes.push((n & 0x7f) | 0x80); n >>>= 7; }
    bytes.push(n);
    return bytes;
  };
  const literalBlock = (payload) => {
    const len = payload.length;
    const lenMinus1 = len - 1;
    let tag;
    if (len <= 60) {
      tag = [((len - 1) << 2) | 0x00];
    } else {
      const extraBytes = lenMinus1 < 0x100 ? 1 : lenMinus1 < 0x10000 ? 2 : lenMinus1 < 0x1000000 ? 3 : 4;
      const lenTag = 59 + extraBytes;
      const lenBytes = [];
      for (let i = 0; i < extraBytes; i++) lenBytes.push((lenMinus1 >>> (8 * i)) & 0xff);
      tag = [(lenTag << 2) | 0x00, ...lenBytes];
    }
    return new Uint8Array([...encodeVarint(len), ...tag, ...payload]);
  };

  const header = new Uint8Array(16);
  header.set(SNAPPY_MAGIC, 0);
  new DataView(header.buffer).setInt32(8, 1, false);
  new DataView(header.buffer).setInt32(12, 1, false);

  const parts = [header];
  for (const payload of payloads) {
    const block = literalBlock(payload);
    const lenPrefix = new Uint8Array(4);
    new DataView(lenPrefix.buffer).setUint32(0, block.length, false);
    parts.push(lenPrefix, block);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function snappyRawBlock(payload) { return snappyRawBlocks([payload]); }

describe('runParse: dropped-file path', () => {
  const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-d","App Name":"drop","Timestamp":1}\n{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n';

  it('parses a plain uncompressed dropped log', async () => {
    const emitted = [];
    await runParse(fakeFile(strToU8(ndjson)), createState(), { emit: m => emitted.push(m) });
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('drop');
    expect(emitted.some(m => m.type === 'done')).toBe(true);
    expect(emitted.some(m => m.type === 'error')).toBe(false);
  });

  it('posts the final normalized app evidence payload immediately before done', async () => {
    const emitted = [];
    await runParse(fakeFile(strToU8(ndjson)), createState(), { emit: m => emitted.push(m) });

    const doneIndex = emitted.findIndex(m => m.type === 'done');
    expect(emitted[doneIndex - 1]).toMatchObject({
      type: 'app',
      data: { evidenceInputs: { applicationEnds: 1, environmentUpdates: 0 } },
    });
    expect(emitted[doneIndex - 2].type).toBe('stageExecutorMetrics');
    expect(emitted[doneIndex - 3].type).toBe('stageSpeculationWaste');
    expect(emitted[doneIndex - 4].type).toBe('runAggregates');
  });

  it('decompresses and parses a dropped gzip log', async () => {
    const emitted = [];
    await runParse(fakeFile(gzipSync(strToU8(ndjson)), 'eventlog.gz'), createState(), { emit: m => emitted.push(m) });
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('drop');
    expect(emitted.some(m => m.type === 'error')).toBe(false);
  });

  it('streams a multi-read-slice gzip log (inflates chunk-by-chunk, splits lines across boundaries)', async () => {
    // Many distinct app-log lines; a tiny chunkSize forces the gzip bytes to be
    // pushed in dozens of read slices → many separate inflate chunks, exercising
    // the streaming path and cross-chunk line reassembly.
    let ndjsonBig = '{"Event":"SparkListenerLogStart","Spark Version":"3.5.3"}\n';
    ndjsonBig += '{"Event":"SparkListenerApplicationStart","App ID":"app-big","App Name":"streamed","Timestamp":1}\n';
    for (let i = 0; i < 400; i++) {
      ndjsonBig += `{"Event":"SparkListenerJobStart","Job ID":${i},"Submission Time":${i},"Stage IDs":[${i}]}\n`;
      ndjsonBig += `{"Event":"SparkListenerJobEnd","Job ID":${i},"Completion Time":${i + 1},"Job Result":{"Result":"JobSucceeded"}}\n`;
    }
    ndjsonBig += '{"Event":"SparkListenerApplicationEnd","Timestamp":9999}\n';
    const gz = gzipSync(strToU8(ndjsonBig));
    expect(gz.length).toBeGreaterThan(64); // guarantees >1 read slice at chunkSize 64

    const state = createState();
    const emitted = [];
    await runParse(fakeFile(gz, 'big.gz'), state, { emit: m => emitted.push(m), chunkSize: 64 });

    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('streamed');
    expect(emitted.find(m => m.type === 'app')?.data?.sparkVersion).toBe('3.5.3');
    expect(emitted.filter(m => m.type === 'job')).toHaveLength(400);
    expect(state.jobs.size).toBe(400);
  });

  it('decompresses and parses a dropped Spark LZ4Block log', async () => {
    const emitted = [];
    await runParse(fakeFile(lz4RawBlock(strToU8(ndjson)), 'eventlog.lz4'), createState(), { emit: m => emitted.push(m) });
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('drop');
    expect(emitted.some(m => m.type === 'error')).toBe(false);
  });

  it('streams a multi-block LZ4Block log across read-slice boundaries', async () => {
    // Two blocks whose framing straddles the tiny read slices; the streaming
    // block decoder must buffer partial blocks until each completes.
    const b1 = lz4RawBlock(strToU8('{"Event":"SparkListenerApplicationStart","App ID":"a","App Name":"multi","Timestamp":1}\n{"Event":"Spar'));
    const b2 = lz4RawBlock(strToU8('kListenerApplicationEnd","Timestamp":2}\n'));
    const both = new Uint8Array(b1.length + b2.length);
    both.set(b1, 0); both.set(b2, b1.length);

    const emitted = [];
    await runParse(fakeFile(both, 'multi.lz4'), createState(), { emit: m => emitted.push(m), chunkSize: 16 });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('multi');
    expect(emitted.some(m => m.type === 'app' && m.data.endTime === 2)).toBe(true);
  });

  it('decompresses and parses a dropped Zstandard log', async () => {
    const emitted = [];
    await runParse(fakeFile(zstdSync(strToU8(ndjson)), 'eventlog.zstd'), createState(), { emit: m => emitted.push(m) });
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('drop');
    expect(emitted.some(m => m.type === 'error')).toBe(false);
  });

  it('streams a multi-read-slice Zstandard log (decompresses chunk-by-chunk, splits lines across boundaries)', async () => {
    // Same shape as the gzip streaming test: many distinct lines and a tiny
    // chunkSize force the zstd frame to arrive in dozens of read slices,
    // exercising the streaming Decompress path and cross-chunk reassembly.
    let ndjsonBig = '{"Event":"SparkListenerLogStart","Spark Version":"3.5.3"}\n';
    ndjsonBig += '{"Event":"SparkListenerApplicationStart","App ID":"app-bigz","App Name":"streamed-z","Timestamp":1}\n';
    for (let i = 0; i < 400; i++) {
      ndjsonBig += `{"Event":"SparkListenerJobStart","Job ID":${i},"Submission Time":${i},"Stage IDs":[${i}]}\n`;
      ndjsonBig += `{"Event":"SparkListenerJobEnd","Job ID":${i},"Completion Time":${i + 1},"Job Result":{"Result":"JobSucceeded"}}\n`;
    }
    ndjsonBig += '{"Event":"SparkListenerApplicationEnd","Timestamp":9999}\n';
    const zst = zstdSync(strToU8(ndjsonBig));
    expect(zst.length).toBeGreaterThan(64); // guarantees >1 read slice at chunkSize 64

    const state = createState();
    const emitted = [];
    await runParse(fakeFile(zst, 'big.zstd'), state, { emit: m => emitted.push(m), chunkSize: 64 });

    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('streamed-z');
    expect(emitted.find(m => m.type === 'app')?.data?.sparkVersion).toBe('3.5.3');
    expect(emitted.filter(m => m.type === 'job')).toHaveLength(400);
    expect(state.jobs.size).toBe(400);
  });

  it('decompresses and parses a dropped Snappy log', async () => {
    const emitted = [];
    await runParse(fakeFile(snappyRawBlock(strToU8(ndjson)), 'eventlog.snappy'), createState(), { emit: m => emitted.push(m) });
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('drop');
    expect(emitted.some(m => m.type === 'error')).toBe(false);
  });

  it('streams a multi-block Snappy log across read-slice boundaries', async () => {
    const both = snappyRawBlocks([
      strToU8('{"Event":"SparkListenerApplicationStart","App ID":"a","App Name":"multi","Timestamp":1}\n{"Event":"Spar'),
      strToU8('kListenerApplicationEnd","Timestamp":2}\n'),
    ]);
    const emitted = [];
    await runParse(fakeFile(both, 'multi.snappy'), createState(), { emit: m => emitted.push(m), chunkSize: 16 });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('multi');
    expect(emitted.some(m => m.type === 'app' && m.data.endTime === 2)).toBe(true);
  });

  it('emits an error for an empty dropped file', async () => {
    const emitted = [];
    await runParse(fakeFile(new Uint8Array(0)), createState(), { emit: m => emitted.push(m) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('error');
  });

  it('emits an error when a compressed file cannot be decompressed', async () => {
    // gzip magic but garbage body
    const bad = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff]);
    const emitted = [];
    await runParse(fakeFile(bad, 'eventlog.gz'), createState(), { emit: m => emitted.push(m) });
    expect(emitted.some(m => m.type === 'error')).toBe(true);
  });
});

describe('runParseFiles: rolling directory (multi-file, ordered)', () => {
  it('parses an ordered array of files as one continuous NDJSON stream', async () => {
    const f1 = fakeFile(strToU8('{"Event":"SparkListenerApplicationStart","App ID":"a","App Name":"rolling-dir","Timestamp":1}\n'), 'events_1_app');
    const f2 = fakeFile(strToU8('{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n'), 'events_2_app');
    const emitted = [];
    await runParseFiles([f1, f2], createState(), { emit: m => emitted.push(m) });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('rolling-dir');
    expect(emitted.some(m => m.type === 'app' && m.data.endTime === 2)).toBe(true);
    expect(emitted.some(m => m.type === 'done')).toBe(true);
  });

  it('keeps the NDJSON line-decoder alive across a file-roll boundary that splits a line', async () => {
    const f1 = fakeFile(strToU8('{"Event":"SparkListenerApplicationStart","App ID":"a","App Name":"split'), 'events_1_app');
    const f2 = fakeFile(strToU8('-name","Timestamp":1}\n'), 'events_2_app');
    const emitted = [];
    await runParseFiles([f1, f2], createState(), { emit: m => emitted.push(m) });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('split-name');
  });

  it('decompresses each file with its own fresh decompressor instance (per-file gzip)', async () => {
    const f1 = fakeFile(gzipSync(strToU8('{"Event":"SparkListenerApplicationStart","App ID":"a","App Name":"gz-multi","Timestamp":1}\n')), 'events_1_app.gz');
    const f2 = fakeFile(gzipSync(strToU8('{"Event":"SparkListenerApplicationEnd","Timestamp":2}\n')), 'events_2_app.gz');
    const emitted = [];
    await runParseFiles([f1, f2], createState(), { emit: m => emitted.push(m) });
    expect(emitted.some(m => m.type === 'error')).toBe(false);
    expect(emitted.find(m => m.type === 'app')?.data?.name).toBe('gz-multi');
  });

  it('emits an error for an empty file list', async () => {
    const emitted = [];
    await runParseFiles([], createState(), { emit: m => emitted.push(m) });
    expect(emitted).toEqual([{ type: 'error', message: 'Rolling event-log directory contained no event files.' }]);
  });

  it('stops and emits an error when a later file in the sequence cannot be decompressed', async () => {
    const f1 = fakeFile(strToU8('{"Event":"SparkListenerApplicationStart","App ID":"a","App Name":"multi","Timestamp":1}\n'), 'events_1_app');
    // gzip magic but garbage body: sniffed as gz, fails during inflate.
    const bad = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff]);
    const f2 = fakeFile(bad, 'events_2_app.gz');
    const emitted = [];
    await runParseFiles([f1, f2], createState(), { emit: m => emitted.push(m) });
    expect(emitted.some(m => m.type === 'error' && m.message.includes('Could not decompress "events_2_app.gz"'))).toBe(true);
    expect(emitted.some(m => m.type === 'done')).toBe(false);
  });

  it('emits "not a Spark event log" when no file across the whole sequence contains ApplicationStart', async () => {
    const emitted = [];
    await runParseFiles(
      [fakeFile(strToU8('{"Event":"SparkListenerJobStart","Job ID":1}\n'), 'events_1_app')],
      createState(),
      { emit: m => emitted.push(m) },
    );
    expect(emitted).toContainEqual({ type: 'error', message: 'Not a Spark event log: no application-start event found. Choose a Spark event log file, or check the docs for supported formats.' });
    expect(emitted.some(m => m.type === 'done')).toBe(false);
  });
});

describe('taskStore retains launch/finish timestamps (stride migration)', () => {
  it('FIELDS gains LAUNCH_TIME=6, FINISH_TIME=7, STRIDE=8', () => {
    expect(FIELDS.LAUNCH_TIME).toBe(6);
    expect(FIELDS.FINISH_TIME).toBe(7);
    expect(FIELDS.STRIDE).toBe(8);
  });

  it('TASK_FIELD_NAMES appends launchTime, finishTime', () => {
    expect(TASK_FIELD_NAMES).toEqual([
      'duration', 'gcTime', 'memorySpilled', 'diskSpilled',
      'shuffleRead', 'shuffleWrite', 'launchTime', 'finishTime',
    ]);
  });

  it('stores raw launch/finish per task in the taskStore Float64Array', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
      'Task Info': { 'Index': 0, 'Launch Time': 1000, 'Finish Time': 1500 },
      'Task Metrics': {} }, s);
    processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 2000 } }, s);
    const arr = s.taskStore.get(1);
    expect(arr[FIELDS.LAUNCH_TIME]).toBe(1000);
    expect(arr[FIELDS.FINISH_TIME]).toBe(1500);
    expect(arr[FIELDS.DURATION]).toBe(500);
  });
});

describe('accumulateTask: per-task Executor CPU Time summed per stage', () => {
  function setupStage(s, id = 1) {
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': id, 'Submission Time': 0 } }, s);
  }

  it('sums Executor CPU Time across tasks into stage.executorCpuTime', () => {
    const s = createState();
    setupStage(s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100 },
      'Task Metrics': { 'Executor CPU Time': 300 } }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100 },
      'Task Metrics': { 'Executor CPU Time': 700 } }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.executorCpuTime).toBe(1000);
  });

  it('defaults executorCpuTime to 0 when the metric is absent', () => {
    const s = createState();
    setupStage(s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100 },
      'Task Metrics': {} }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.executorCpuTime).toBe(0);
  });
});

describe('accumulateTask: accumulator-to-stage capture', () => {
  function submitAndStartStage(state, stageId) {
    processEvent({
      Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': stageId, 'Stage Attempt ID': 0, 'Stage Name': 's', 'Number of Tasks': 1, 'Submission Time': 0 },
    }, state);
  }

  it('records the accumulator ID against the task\'s Stage ID', () => {
    const state = createState();
    submitAndStartStage(state, 7);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 7,
      'Stage Attempt ID': 0,
      'Task End Reason': { Reason: 'Success' },
      'Task Info': {
        'Launch Time': 0, 'Finish Time': 100, Index: 0,
        Accumulables: [{ ID: 42, Update: '10', Value: '10' }, { ID: 43, Update: '5', Value: '5' }],
      },
      'Task Metrics': {},
    }, state);

    expect(state.taskAccumStages.get(42)).toEqual(new Set([7]));
    expect(state.taskAccumStages.get(43)).toEqual(new Set([7]));
  });

  it('dedupes repeated accumulator IDs across multiple tasks in the same stage into one Set entry', () => {
    const state = createState();
    submitAndStartStage(state, 7);
    for (const index of [0, 1]) {
      processEvent({
        Event: 'SparkListenerTaskEnd',
        'Stage ID': 7,
        'Stage Attempt ID': 0,
        'Task Info': { 'Launch Time': 0, 'Finish Time': 10, Index: index, Accumulables: [{ ID: 42 }] },
        'Task Metrics': {},
      }, state);
    }
    expect(state.taskAccumStages.get(42)).toEqual(new Set([7]));
  });

  it('does nothing when Accumulables is absent', () => {
    const state = createState();
    submitAndStartStage(state, 7);
    processEvent({
      Event: 'SparkListenerTaskEnd',
      'Stage ID': 7,
      'Stage Attempt ID': 0,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 10, Index: 0 },
      'Task Metrics': {},
    }, state);
    expect(state.taskAccumStages.size).toBe(0);
  });
});

describe('finalizeStage: per-executor stage participation stats', () => {
  function setupStage(s, id = 1) {
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': id, 'Submission Time': 0 } }, s);
  }

  it('aggregates executorStats keyed by Task Info Executor ID', () => {
    const s = createState();
    setupStage(s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100, 'Executor ID': 'exec-1' },
      'Task Metrics': {} }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 300, 'Executor ID': 'exec-1' },
      'Task Metrics': {} }, s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 50, 'Executor ID': 'exec-2' },
      'Task Metrics': {} }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 400 } }, s);
    expect(Array.isArray(msg.data.executorStats)).toBe(true);
    expect(msg.data.executorStats).toEqual(expect.arrayContaining([
      { executorId: 'exec-1', taskCount: 2, totalDuration: 400, inputBytes: 0, shuffleReadBytes: 0, shuffleWriteBytes: 0 },
      { executorId: 'exec-2', taskCount: 1, totalDuration: 50, inputBytes: 0, shuffleReadBytes: 0, shuffleWriteBytes: 0 },
    ]));
  });

  it('omits tasks with no Executor ID from executorStats', () => {
    const s = createState();
    setupStage(s);
    processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Launch Time': 0, 'Finish Time': 100 },
      'Task Metrics': {} }, s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.executorStats).toEqual([]);
  });

  it('sums input/shuffle bytes per executor into executorStats', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    function task(exec, input, sr, sw) {
      processEvent({ Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
        'Task Info': { 'Index': task._i = (task._i ?? 0) + 1, 'Executor ID': exec,
          'Launch Time': 0, 'Finish Time': 100, 'Host': 'h1' },
        'Task Metrics': { 'Input Metrics': { 'Bytes Read': input },
          'Shuffle Read Metrics': { 'Remote Bytes Read': sr, 'Local Bytes Read': 0 },
          'Shuffle Write Metrics': { 'Shuffle Bytes Written': sw } } }, s);
    }
    task('e1', 100, 10, 5);
    task('e1', 200, 20, 5);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    const e1 = msg.data.executorStats.find(e => e.executorId === 'e1');
    expect(e1).toMatchObject({ taskCount: 2, inputBytes: 300, shuffleReadBytes: 30, shuffleWriteBytes: 10 });
  });
});

describe('processEvent: job-level SQL execution ID', () => {
  it('captures sqlExecutionId at JobStart, surfaced on the JobEnd message', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerJobStart', 'Job ID': 5,
      'Stage IDs': [1], Properties: { 'spark.sql.execution.id': '42' } }, s);
    const msg = processEvent({ Event: 'SparkListenerJobEnd', 'Job ID': 5,
      'Job Result': { Result: 'JobSucceeded' }, 'Completion Time': 900 }, s);
    expect(msg.data.sqlExecutionId).toBe(42);
  });

  it('sqlExecutionId is null when no SQL execution property present', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerJobStart', 'Job ID': 6,
      'Stage IDs': [1], Properties: {} }, s);
    const msg = processEvent({ Event: 'SparkListenerJobEnd', 'Job ID': 6,
      'Job Result': { Result: 'JobSucceeded' } }, s);
    expect(msg.data.sqlExecutionId).toBeNull();
  });

  it('sqlExecutionId is null when JobEnd arrives with no prior JobStart', () => {
    const s = createState();
    const msg = processEvent({ Event: 'SparkListenerJobEnd', 'Job ID': 7,
      'Job Result': { Result: 'JobSucceeded' } }, s);
    expect(msg.data.sqlExecutionId).toBeNull();
  });
});

describe('processEvent: stage-level failure reason', () => {
  function setupStage(s, id = 1) {
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': id, 'Submission Time': 0 } }, s);
  }

  it('captures Stage Info Failure Reason as stageFailureReason', () => {
    const s = createState();
    setupStage(s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200,
        'Failure Reason': 'Job aborted due to stage failure' } }, s);
    expect(msg.data.stageFailureReason).toBe('Job aborted due to stage failure');
  });

  it('stageFailureReason is null when Failure Reason absent', () => {
    const s = createState();
    setupStage(s);
    const msg = processEvent({ Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200 } }, s);
    expect(msg.data.stageFailureReason).toBeNull();
  });
});

describe('processEvent: app-level RDD-info map', () => {
  it('createState includes rddInfo as an empty Map', () => {
    const s = createState();
    expect(s.rddInfo).toBeInstanceOf(Map);
    expect(s.rddInfo.size).toBe(0);
  });

  it('captures RDD Info, mapping storage level, sizes, callsite, and stage ids', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerApplicationStart',
      'App ID': 'app_r', 'App Name': 'r', 'Timestamp': 1 }, s);
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 0, 'RDD Info': [
        { 'RDD ID': 7, 'Name': 'blocks', 'Callsite': 'collect at /u02/hadoop/app/utils.py:1869',
          'Storage Level': { 'Use Disk': false, 'Use Memory': true, 'Deserialized': true, 'Replication': 1 },
          'Number of Partitions': 10, 'Number of Cached Partitions': 3,
          'Memory Size': 100, 'Disk Size': 0 },
      ] } }, s);
    expect(s.rddInfo.get(7)).toEqual({
      id: 7, name: 'blocks', callsite: 'collect at /u02/hadoop/app/utils.py:1869',
      storageLevel: { useDisk: false, useMemory: true, deserialized: true, replication: 1 },
      numPartitions: 10, numCachedPartitions: 3, memorySize: 100, diskSize: 0, storageSource: 'rddInfo',
      stageIds: new Set([1]),
    });
  });

  it('accumulates stage ids across multiple stage submissions and dedupes by RDD ID, latest field values win', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerApplicationStart',
      'App ID': 'app_r', 'App Name': 'r', 'Timestamp': 1 }, s);
    const rdd = (cached, mem) => ({ 'RDD ID': 7, 'Name': 'blocks', 'Callsite': 'collect at utils.py:10',
      'Storage Level': { 'Use Memory': true },
      'Number of Partitions': 10, 'Number of Cached Partitions': cached,
      'Memory Size': mem, 'Disk Size': 0 });
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 0, 'RDD Info': [rdd(3, 100)] } }, s);
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 2, 'Submission Time': 0, 'RDD Info': [rdd(8, 200)] } }, s);
    expect(s.rddInfo.size).toBe(1);
    expect(s.rddInfo.get(7).numCachedPartitions).toBe(8);
    expect(s.rddInfo.get(7).memorySize).toBe(200);
    expect(s.rddInfo.get(7).stageIds).toEqual(new Set([1, 2]));
  });

  it('posts rddInfo with each entry\'s stageIds as a sorted array (not a Set) once the app ends', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerApplicationStart',
      'App ID': 'app_r', 'App Name': 'r', 'Timestamp': 1 }, s);
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 2, 'Submission Time': 0,
      'RDD Info': [{ 'RDD ID': 7, 'Name': 'blocks', 'Callsite': 'collect at utils.py:10',
        'Storage Level': {}, 'Number of Partitions': 1 }] } }, s);
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0,
      'RDD Info': [{ 'RDD ID': 7, 'Name': 'blocks', 'Callsite': 'collect at utils.py:10',
        'Storage Level': {}, 'Number of Partitions': 1 }] } }, s);
    const msg = processEvent({ Event: 'SparkListenerApplicationEnd', 'Timestamp': 100 }, s);
    expect(msg.data.rddInfo.get(7).stageIds).toEqual([1, 2]);
  });

  it('keeps a previously observed non-zero size when a later resubmission reports zero', () => {
    const s = createState();
    const rdd = (cached, mem, disk) => ({ 'RDD ID': 7, 'Name': 'blocks',
      'Storage Level': { 'Use Memory': true },
      'Number of Partitions': 10, 'Number of Cached Partitions': cached,
      'Memory Size': mem, 'Disk Size': disk });
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 0, 'RDD Info': [rdd(8, 200, 0)] } }, s);
    // RDD 7 resubmitted in a later stage before BlockManager reports its cache
    // state again; Spark's own snapshot is legitimately 0 at that instant.
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 2, 'Submission Time': 0, 'RDD Info': [rdd(0, 0, 0)] } }, s);
    expect(s.rddInfo.get(7).numCachedPartitions).toBe(8);
    expect(s.rddInfo.get(7).memorySize).toBe(200);
  });

  it('carries rddInfo on the ApplicationEnd message', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerApplicationStart',
      'App ID': 'app_r', 'App Name': 'r', 'Timestamp': 1 }, s);
    processEvent({ Event: 'SparkListenerStageSubmitted',
      'Stage Info': { 'Stage ID': 1, 'Submission Time': 0, 'RDD Info': [
        { 'RDD ID': 7, 'Name': 'blocks', 'Storage Level': { 'Use Memory': true },
          'Number of Partitions': 10, 'Number of Cached Partitions': 3,
          'Memory Size': 100, 'Disk Size': 0 } ] } }, s);
    const endMsg = processEvent({ Event: 'SparkListenerApplicationEnd', 'Timestamp': 999 }, s);
    expect(endMsg.data.rddInfo).toBeInstanceOf(Map);
    expect(endMsg.data.rddInfo.get(7).numCachedPartitions).toBe(3);
  });

  it('counts stage references per RDD across StageSubmitted events', () => {
    const s = createState();
    function submit(stageId, rddId) {
      processEvent({ Event: 'SparkListenerStageSubmitted',
        'Stage Info': { 'Stage ID': stageId, 'Submission Time': 0,
          'RDD Info': [{ 'RDD ID': rddId, 'Name': 'r', 'Storage Level': {} }] } }, s);
    }
    submit(1, 7); submit(2, 7); submit(3, 7);
    expect(s.rddInfo.get(7).stageIds).toEqual(new Set([1, 2, 3]));
  });
});

describe('processEvent: SparkListenerBlockUpdated', () => {
  const MEMORY_ONLY = { 'Use Disk': false, 'Use Memory': true, 'Deserialized': true, 'Replication': 1 };
  const MEMORY_AND_DISK = { 'Use Disk': true, 'Use Memory': true, 'Deserialized': true, 'Replication': 1 };
  const ON_DISK = { 'Use Disk': true, 'Use Memory': false, 'Deserialized': true, 'Replication': 1 };
  const NONE = { 'Use Disk': false, 'Use Memory': false, 'Deserialized': false, 'Replication': 1 };
  const blockEvent = (blockId, level, mem, disk, executorId = '1') => ({
    Event: 'SparkListenerBlockUpdated',
    'Block Updated Info': {
      'Block Manager ID': { 'Executor ID': executorId, 'Host': 'h', 'Port': 1 },
      'Block ID': blockId, 'Storage Level': level, 'Memory Size': mem, 'Disk Size': disk,
    },
  });
  // Spark 2.3+ RDD Info: the storage level and partition count are real, the cache figures are 0.
  const submitWithRdd = (s, stageId, level) => processEvent({ Event: 'SparkListenerStageSubmitted',
    'Stage Info': { 'Stage ID': stageId, 'Submission Time': 0, 'RDD Info': [
      { 'RDD ID': 4, 'Name': 'cached', 'Storage Level': level, 'Number of Partitions': 10,
        'Number of Cached Partitions': 0, 'Memory Size': 0, 'Disk Size': 0 },
    ] } }, s);

  it('folds rdd_* blocks into the RDD\'s cached-partition count and memory/disk bytes', () => {
    const s = createState();
    submitWithRdd(s, 1, MEMORY_AND_DISK);
    processEvent(blockEvent('rdd_4_0', MEMORY_AND_DISK, 100, 0), s);
    processEvent(blockEvent('rdd_4_1', ON_DISK, 0, 300), s);
    expect(s.rddInfo.get(4)).toMatchObject({
      name: 'cached', numPartitions: 10, numCachedPartitions: 2, memorySize: 100, diskSize: 300,
      storageSource: 'blockUpdates',
    });
    expect(s.rddBlockUpdates).toBe(2);
  });

  it('ignores broadcast and other non-RDD blocks', () => {
    const s = createState();
    processEvent(blockEvent('broadcast_0_piece0', MEMORY_ONLY, 512, 0, 'driver'), s);
    processEvent(blockEvent('rdd_4_x', MEMORY_ONLY, 512, 0), s);
    expect(s.rddInfo.size).toBe(0);
    expect(s.rddBlockUpdates).toBe(0);
  });

  it('counts a partition replicated on two executors once, summing both replicas\' bytes', () => {
    const s = createState();
    submitWithRdd(s, 1, MEMORY_ONLY);
    processEvent(blockEvent('rdd_4_0', MEMORY_ONLY, 100, 0, '1'), s);
    processEvent(blockEvent('rdd_4_0', MEMORY_ONLY, 100, 0, '2'), s);
    expect(s.rddInfo.get(4)).toMatchObject({ numCachedPartitions: 1, memorySize: 200 });
  });

  it('moves a block\'s bytes from memory to disk when it is dropped to disk', () => {
    const s = createState();
    submitWithRdd(s, 1, MEMORY_AND_DISK);
    processEvent(blockEvent('rdd_4_0', MEMORY_AND_DISK, 100, 0), s);
    // Spark still reports the dropped bytes as Memory Size on a drop to disk; only the level counts.
    processEvent(blockEvent('rdd_4_0', ON_DISK, 100, 100), s);
    expect(s.rddInfo.get(4)).toMatchObject({ numCachedPartitions: 1, memorySize: 0, diskSize: 100 });
  });

  it('keeps the peak residency after unpersist removes every block', () => {
    const s = createState();
    submitWithRdd(s, 1, MEMORY_ONLY);
    for (const p of [0, 1, 2]) processEvent(blockEvent(`rdd_4_${p}`, MEMORY_ONLY, 100, 0), s);
    for (const p of [0, 1, 2]) processEvent(blockEvent(`rdd_4_${p}`, NONE, 0, 0), s);
    expect(s.rddInfo.get(4)).toMatchObject({ numCachedPartitions: 3, memorySize: 300 });
  });

  it('keeps block-derived figures when a later stage\'s RDD Info reports 0 again', () => {
    const s = createState();
    submitWithRdd(s, 1, MEMORY_ONLY);
    processEvent(blockEvent('rdd_4_0', MEMORY_ONLY, 100, 0), s);
    submitWithRdd(s, 2, MEMORY_ONLY);
    expect(s.rddInfo.get(4)).toMatchObject({
      numCachedPartitions: 1, memorySize: 100, storageSource: 'blockUpdates', stageIds: new Set([1, 2]),
    });
  });

  it('keeps the persisted storage level when a stage after unpersist() lists the RDD as NONE', () => {
    const s = createState();
    submitWithRdd(s, 1, MEMORY_ONLY);
    processEvent(blockEvent('rdd_4_0', MEMORY_ONLY, 100, 0), s);
    processEvent(blockEvent('rdd_4_0', NONE, 0, 0), s);
    submitWithRdd(s, 2, NONE);
    expect(s.rddInfo.get(4)).toMatchObject({
      storageLevel: { useMemory: true, useDisk: false }, numCachedPartitions: 1, memorySize: 100,
    });
  });

  it('takes the storage level from RDD Info when it has no block updates', () => {
    const s = createState();
    submitWithRdd(s, 1, MEMORY_ONLY);
    submitWithRdd(s, 2, NONE);
    expect(s.rddInfo.get(4).storageLevel).toMatchObject({ useMemory: false, useDisk: false });
  });

  it('drops a removed executor\'s blocks, so a partition re-cached elsewhere is counted once', () => {
    const s = createState();
    submitWithRdd(s, 1, MEMORY_ONLY);
    for (const p of [0, 1]) processEvent(blockEvent(`rdd_4_${p}`, MEMORY_ONLY, 100, 0, '1'), s);
    processEvent(blockEvent('rdd_4_2', MEMORY_ONLY, 100, 0, '11'), s);
    // Spark writes no BlockUpdated for blocks lost with their executor.
    processEvent({ Event: 'SparkListenerExecutorRemoved', 'Timestamp': 50, 'Executor ID': '1', 'Removed Reason': 'lost' }, s);
    for (const p of [0, 1]) processEvent(blockEvent(`rdd_4_${p}`, MEMORY_ONLY, 100, 0, '2'), s);
    expect(s.rddInfo.get(4)).toMatchObject({ numCachedPartitions: 3, memorySize: 300 });
  });

  it('creates the RDD from its block when no stage has listed it yet', () => {
    const s = createState();
    processEvent(blockEvent('rdd_4_0', MEMORY_ONLY, 100, 0), s);
    submitWithRdd(s, 1, MEMORY_ONLY);
    expect(s.rddInfo.get(4)).toMatchObject({ name: 'cached', numPartitions: 10, numCachedPartitions: 1, memorySize: 100 });
  });

  it('posts the rdd block-update count on the app message', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerApplicationStart', 'App ID': 'app_r', 'App Name': 'r', 'Timestamp': 1 }, s);
    processEvent(blockEvent('rdd_4_0', MEMORY_ONLY, 100, 0), s);
    const msg = processEvent({ Event: 'SparkListenerApplicationEnd', 'Timestamp': 100 }, s);
    expect(msg.data.rddBlockUpdates).toBe(1);
  });

  it('drops non-RDD block-update lines before parsing them, without counting them as skipped', () => {
    const s = createState();
    // Not valid JSON past the prefix: only the pre-parse fast path can keep this from counting as skipped.
    dispatchLine('{"Event":"SparkListenerBlockUpdated","Block Updated Info":{"Block ID":"broadcast_1"', s, () => {});
    dispatchLine(JSON.stringify(blockEvent('rdd_4_0', MEMORY_ONLY, 100, 0)), s, () => {});
    expect(s.skippedLines).toBe(0);
    expect(s.rddBlockUpdates).toBe(1);
  });
});

describe('task-level evidence for stageFailed/retryWaste (real ExecutorLostFailure, integration)', () => {
  it('retryWaste finding carries retriedTaskDetails with the failed attempt\'s host/executor/reason', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    for (let i = 0; i < 3; i++) {
      processEvent({
        Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
        'Task End Reason': { Reason: 'ExecutorLostFailure' },
        'Task Info': {
          Index: i, 'Task ID': 100 + i, 'Attempt Number': 0, 'Launch Time': 0, 'Finish Time': 15000,
          Failed: true, Host: 'worker-3.internal', 'Executor ID': 'exec-7',
        },
        'Task Metrics': { 'Peak Execution Memory': 5000, 'Memory Bytes Spilled': 100, 'Shuffle Write Metrics': { 'Shuffle Bytes Written': 2000 } },
      }, s);
      processEvent({
        Event: 'SparkListenerTaskEnd', 'Stage ID': 1, 'Stage Attempt ID': 0,
        'Task Info': {
          Index: i, 'Task ID': 100 + i, 'Attempt Number': 1, 'Launch Time': 15000, 'Finish Time': 15100,
          Failed: false, Host: 'worker-4.internal', 'Executor ID': 'exec-8',
        },
        'Task Metrics': {},
      }, s);
    }
    const msg = processEvent({ Event: 'SparkListenerStageCompleted', 'Stage Info': { 'Stage ID': 1, 'Completion Time': 45300 } }, s);

    const stages = new Map([[1, msg.data]]);
    const catalog = analyze(null, stages, [], [], new Map());
    const finding = catalog.find((f) => f.type === 'retryWaste');
    expect(finding).toBeDefined();
    expect(finding.retriedTaskDetails).toHaveLength(3);
    expect(finding.retriedTaskDetails[0]).toMatchObject({
      taskId: 100, attemptNumber: 0, host: 'worker-3.internal', executorId: 'exec-7',
      reason: 'ExecutorLostFailure', peakExecMem: 5000, memSpilled: 100, shuffleWrite: 2000,
    });
  });

  it('stageFailed finding carries failedTaskDetails for a surviving failed task', () => {
    const s = createState();
    processEvent({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { 'Stage ID': 1, 'Submission Time': 0 } }, s);
    processEvent({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task End Reason': { Reason: 'ExecutorLostFailure' },
      'Task Info': { Index: 0, 'Task ID': 200, 'Attempt Number': 0, 'Launch Time': 0, 'Finish Time': 100, Failed: true, Host: 'worker-9.internal', 'Executor ID': 'exec-1' },
      'Task Metrics': { 'Peak Execution Memory': 100 },
    }, s);
    const msg = processEvent({
      Event: 'SparkListenerStageCompleted',
      'Stage Info': { 'Stage ID': 1, 'Completion Time': 200, 'Failure Reason': 'Job aborted due to stage failure' },
    }, s);

    const stages = new Map([[1, msg.data]]);
    const catalog = analyze(null, stages, [], [], new Map());
    const finding = catalog.find((f) => f.type === 'stageFailed');
    expect(finding).toBeDefined();
    expect(finding.failedTaskDetails).toEqual([
      { taskId: 200, attemptNumber: 0, host: 'worker-9.internal', executorId: 'exec-1', reason: 'ExecutorLostFailure', peakExecMem: 100, memSpilled: 0, shuffleWrite: 0 },
    ]);
  });
});
