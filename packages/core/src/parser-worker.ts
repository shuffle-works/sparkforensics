import { Gunzip } from './vendor/fflate.js';
import { createLz4BlockDecoder } from './lz4-block.ts';
import { Decompress as ZstdDecompress } from './vendor/fzstd.js';
import { createSnappyBlockDecoder } from './snappy-block.ts';
import { createState, dispatchLine, buildChunkDecoder, emitParseCompletion, type JoinedLine, type ParserState } from './event-handlers.ts';
import { TASK_FIELD_NAMES } from './stage-quantiles.ts';
import { runParseFromUrl, sniffCodec } from './shs-fetch.ts';
import { createWorkerZstdDecoders } from './zstd-worker-client.ts';

export {
  buildChunkDecoder, createState, normalizeSparkProperties, parseSparkMemoryMB, extractResources,
  accumulateTask, resolvePlanTree, startApplication, updateEnvironment, startJob, endJob, submitStage,
  mergeStageRddInfo, recordStageExecutorMetrics, startSqlExecution, endSqlExecution,
  applyDriverAccumUpdates, addExecutor, removeExecutor, processEvent, dispatchLine,
  collectStageExecutorMetrics,
} from './event-handlers.ts';

export {
  FIELDS, TASK_FIELD_NAMES, finalizeStage, computeFieldQuantiles, computeDurationQuantiles, classifySpill,
} from './stage-quantiles.ts';

export {
  runParseFromUrl, sniffCodec, decodeShsArchive,
} from './shs-fetch.ts';

export { naturalCompare, reassembleRollingEntries } from './rolling-log-reassembly.ts';

// 512 KB, not a larger round number: Spark logs commonly compress ~15-20x, so a
// coarser chunk decompresses into a burst of tens of thousands of lines at one
// unmoving pct; smaller reads give the progress bar more checkpoints.
const CHUNK_SIZE = 512 * 1024;
const MIN_PROGRESS_STEPS = 100;
// Small emit interval: a highly compressed chunk decodes thousands of lines at
// once, so a large interval yields only a handful of progress messages per file.
const PROGRESS_EMIT_LINES = 300;

type EmitFn = (msg: unknown) => void;
// zstdDecoder replaces the vendored fzstd for zstd input; the Node CLI/MCP path passes
// cli/native-zstd.ts's native-zlib decoder, which a browser bundle can't import.
type RunOpts = { emit?: EmitFn; chunkSize?: number; zstdDecoder?: ZstdDecoderFactory };

// Minimal shape streamFile/runParse/runParseFiles read off `file` (name, size,
// slice(start,end).arrayBuffer()): narrower than the full DOM `File`. A real
// `File` (the browser Worker path) satisfies it structurally, but so does the
// plain object src/cli/collect-run.ts's nodeFileFromPath builds for Node, which
// has no DOM `File` constructor.
type FileSource = {
  name: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

// Incoming message shapes accepted by the worker's `self.onmessage` handler.
type WorkerIncomingMessage =
  | { type: 'parse'; file: File }
  | { type: 'parseFromUrl'; request: unknown }
  | { type: 'parseFiles'; files: File[] }
  | { type: 'getTaskData'; stageId: number; reqId: string | number };

// fflate's Gunzip and fzstd's Decompress are untyped vendor JS, so TS can't
// infer a construct signature for them; this local shape types the call sites
// without touching the vendored files (mirrors shs-fetch.ts's shim).
type StreamingDecoder = { push(chunk: Uint8Array, final?: boolean): void };
type StreamingDecoderCtor = new (onChunk: (chunk: Uint8Array) => void) => StreamingDecoder;
// A Node decoder, or the browser's decompress worker (zstd-worker-client.ts), may decompress off
// the calling thread: streamFile awaits each push, and calls cancel() when it abandons the stream.
export type ZstdDecoderFactory = (onChunk: (chunk: Uint8Array) => void) => {
  push(chunk: Uint8Array, final?: boolean): void | Promise<void>;
  cancel?(): void;
};

// Stream one File's (possibly compressed) bytes through the codec dispatch,
// in `chunkSize` slices, invoking `onChunk` with each decompressed buffer as
// it becomes available. Shared by runParse (single file) and runParseFiles
// (rolling multi-file directories): the codec is sniffed per-file since
// Spark's file-rolling never spans a compressor's own framing.
export async function streamFile(
  file: FileSource,
  onChunk: (chunk: Uint8Array, pct?: number) => void,
  chunkSize: number,
  zstdDecoder?: ZstdDecoderFactory,
): Promise<void> {
  const header = new Uint8Array(await file.slice(0, Math.min(8, file.size)).arrayBuffer());
  const codec = sniffCodec(header);

  // Codec decoders' push() can synchronously invoke their onChunk callback,
  // which was bound once, before the loop below has a `start` to report:
  // route pct through this shared mutable slot instead, updated ahead of
  // each push so compressed codecs report bytes-read progress too, not just
  // the uncompressed branch.
  let currentPct = 0;
  const gunzip = codec === 'gz' ? new (Gunzip as unknown as StreamingDecoderCtor)((inflated) => onChunk(inflated, currentPct)) : null;
  const lz4 = codec === 'lz4' ? createLz4BlockDecoder((inflated) => onChunk(inflated, currentPct)) : null;
  const onZstdChunk = (inflated: Uint8Array) => onChunk(inflated, currentPct);
  const zstd: ReturnType<ZstdDecoderFactory> | null = codec !== 'zstd' ? null
    : zstdDecoder ? zstdDecoder(onZstdChunk)
      : new (ZstdDecompress as unknown as StreamingDecoderCtor)(onZstdChunk);
  const snappy = codec === 'snappy' ? createSnappyBlockDecoder((inflated) => onChunk(inflated, currentPct)) : null;

  // A fixed read size gives too few progress checkpoints on smaller files
  // (e.g. a 3 MB log at 512 KB reads is only ~6 steps, ~15% jumps): cap the
  // read size so every file gets at least MIN_PROGRESS_STEPS reads, however
  // small, while chunkSize still bounds it above for large-file I/O.
  const stepSize = Math.max(1, Math.min(chunkSize, Math.ceil(file.size / MIN_PROGRESS_STEPS)));

  let offset = 0;
  try {
    while (offset < file.size) {
      const start = offset;
      const slice = new Uint8Array(await file.slice(start, start + stepSize).arrayBuffer());
      offset += stepSize;
      const final = offset >= file.size;
      currentPct = start / file.size;
      if (gunzip) gunzip.push(slice, final);
      else if (lz4) lz4.push(slice);
      else if (zstd) await zstd.push(slice, final);
      else if (snappy) snappy.push(slice);
      else onChunk(slice, currentPct);
    }
  } catch (e) {
    zstd?.cancel?.();
    throw e;
  }
  if (lz4) lz4.end();
  if (snappy) snappy.end();
}

// Parse a dropped `File`, always streaming to honor the core invariant: the
// decompressed task-event stream must never be buffered whole. Read in
// `chunkSize` slices; a compressed log is inflated incrementally so only one
// decompressed chunk is live at a time, like the uncompressed path.
// `chunkSize` is injectable so tests can force multi-chunk streaming.
export async function runParse(
  file: FileSource,
  state: ParserState,
  { emit = (msg: unknown) => self.postMessage(msg), chunkSize = CHUNK_SIZE, zstdDecoder }: RunOpts = {},
): Promise<void> {
  if (file.size === 0) {
    emit({ type: 'error', message: 'File is empty.' });
    return;
  }

  const decoder = buildChunkDecoder();
  const joined: JoinedLine[] = [];
  let linesProcessed = 0;
  const feed = (bytes: Uint8Array, pct?: number) => {
    joined.length = 0;
    const lines = decoder.decode(bytes, joined);
    for (let i = 0, j = 0; i < lines.length; i++) {
      dispatchLine(lines[i], state, emit, joined[j]?.index === i ? joined[j++] : undefined);
      linesProcessed++;
      if (linesProcessed % PROGRESS_EMIT_LINES === 0) {
        emit({ type: 'progress', pct: pct ?? null, linesProcessed });
      }
    }
  };

  try {
    await streamFile(file, feed, chunkSize, zstdDecoder);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit({ type: 'error', message: `Could not decompress "${file.name}": ${message}` });
    return;
  }

  for (const line of decoder.flush()) {
    dispatchLine(line, state, emit);
  }

  if (!state.app) {
    emit({ type: 'error', message: 'Not a Spark event log: no application-start event found. Choose a Spark event log file, or check the docs for supported formats.' });
    return;
  }

  emitParseCompletion(state, emit, linesProcessed);
}

// Parse a rolling `eventlog_v2_*` directory: an ordered array of File objects
// (already deduped/sorted by reassembleRollingEntries) representing
// `events_<index>_...` files. Reuses the same chunked streaming codec
// dispatch as runParse, once per file in sequence, but keeps ONE NDJSON
// line-decoder alive across all files: nothing in the rolling-log format
// guarantees a file-roll boundary lands on a line boundary.
export async function runParseFiles(
  files: FileSource[],
  state: ParserState,
  { emit = (msg: unknown) => self.postMessage(msg), chunkSize = CHUNK_SIZE, zstdDecoder }: RunOpts = {},
): Promise<void> {
  if (files.length === 0) {
    emit({ type: 'error', message: 'Rolling event-log directory contained no event files.' });
    return;
  }

  const decoder = buildChunkDecoder();
  const joined: JoinedLine[] = [];
  let linesProcessed = 0;
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  let bytesBeforeCurrentFile = 0;
  let currentFileSize = 0;
  const feed = (bytes: Uint8Array, pct?: number) => {
    joined.length = 0;
    const lines = decoder.decode(bytes, joined);
    for (let i = 0, j = 0; i < lines.length; i++) {
      dispatchLine(lines[i], state, emit, joined[j]?.index === i ? joined[j++] : undefined);
      linesProcessed++;
      if (linesProcessed % PROGRESS_EMIT_LINES === 0) {
        const overallPct = totalSize > 0 ? (bytesBeforeCurrentFile + (pct ?? 0) * currentFileSize) / totalSize : null;
        emit({ type: 'progress', pct: overallPct, linesProcessed });
      }
    }
  };

  for (const file of files) {
    currentFileSize = file.size;
    try {
      await streamFile(file, feed, chunkSize, zstdDecoder);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      emit({ type: 'error', message: `Could not decompress "${file.name}": ${message}` });
      return;
    }
    bytesBeforeCurrentFile += file.size;
  }

  for (const line of decoder.flush()) {
    dispatchLine(line, state, emit);
  }

  if (!state.app) {
    emit({ type: 'error', message: 'Not a Spark event log: no application-start event found. Choose a Spark event log file, or check the docs for supported formats.' });
    return;
  }

  emitParseCompletion(state, emit, linesProcessed);
}

// ─── Worker message bus (only active when running as a Web Worker) ──────────────

const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

if (isWorker) {
  let workerState: ParserState | null = null;
  // Dropped zstd files decompress in a second worker, overlapping with parsing here. The
  // `new Worker(new URL(...))` stays inline for Vite's worker detection (see ingest.ts). The SHS
  // path (runParseFromUrl) decodes whole zip entries synchronously and keeps in-thread fzstd.
  const zstdDecoder = createWorkerZstdDecoders(
    () => new Worker(new URL('./zstd-worker.js', import.meta.url), { type: 'module' }),
    (onChunk) => new (ZstdDecompress as unknown as StreamingDecoderCtor)(onChunk),
    { onFallback: (reason) => console.warn(`zstd: decompressing on the parse worker: ${reason}`) },
  );

  self.onmessage = async ({ data }: MessageEvent<WorkerIncomingMessage>) => {
    if (data.type === 'parse') {
      workerState = createState();
      await runParse(data.file, workerState, { zstdDecoder });
    } else if (data.type === 'parseFromUrl') {
      workerState = createState();
      await runParseFromUrl(data.request, workerState);
    } else if (data.type === 'parseFiles') {
      workerState = createState();
      await runParseFiles(data.files, workerState, { zstdDecoder });
    } else if (data.type === 'getTaskData') {
      const { stageId, reqId } = data;
      const stored = workerState?.taskStore.get(stageId) ?? new Float64Array(0);
      self.postMessage({
        type: 'taskData', stageId, reqId,
        metrics: stored.slice(),
        fieldNames: TASK_FIELD_NAMES,
      });
    }
  };
}
