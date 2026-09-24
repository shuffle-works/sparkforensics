import { Gunzip } from './vendor/fflate.js';
import { createLz4BlockDecoder } from './lz4-block.ts';
import { Decompress as ZstdDecompress } from './vendor/fzstd.js';
import { createSnappyBlockDecoder } from './snappy-block.ts';
import { buildProxyRequestUrl, isShsErrorCode } from './shs-request.js';
import { dispatchLine, buildChunkDecoder, emitParseCompletion, type JoinedLine, type ParserState } from './event-handlers.ts';
import { ShsProxyErrorBodySchema } from './shs-schemas.ts';
import { naturalCompare, reassembleRollingEntries } from './rolling-log-reassembly.ts';
import { listZipEntries, streamZipEntry, type ZipEntry, type ZipSource } from './zip-archive.ts';
import type { ZstdDecoderFactory } from './parser-worker.ts';

export { naturalCompare, reassembleRollingEntries };

// Sniff a compression codec from leading magic bytes: gzip (1f 8b), Zstandard
// (28 b5 2f fd), Spark's custom "LZ4Block" framing, or Spark's Snappy framing
// (org.xerial.snappy's "\x82SNAPPY\0" header). Returns 'gz' | 'zstd' | 'lz4' |
// 'snappy' | null. More robust than a filename suffix: a dropped SHS log may
// have no extension.
export function sniffCodec(bytes: Uint8Array): 'gz' | 'zstd' | 'lz4' | 'snappy' | null {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gz';
  if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) return 'zstd';
  const LZ4_MAGIC = [76, 90, 52, 66, 108, 111, 99, 107]; // "LZ4Block"
  if (bytes.length >= 8 && LZ4_MAGIC.every((b, i) => bytes[i] === b)) return 'lz4';
  const SNAPPY_MAGIC = [0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]; // 0x82 'S' 'N' 'A' 'P' 'P' 'Y' 0x00
  if (bytes.length >= 8 && SNAPPY_MAGIC.every((b, i) => bytes[i] === b)) return 'snappy';
  return null;
}

// Decodes one zip entry's (possibly compressed) bytes as they stream out of
// the archive, block by block, invoking `onChunk` per decompressed piece;
// never materializes the whole decompressed entry as one buffer. A giant
// single-segment zstd frame (or gzip member) declares its full content size in
// the header; one-shotting it (fzstd's `decompress()`, fflate's `gunzipSync()`)
// allocates that entire size as a single ArrayBuffer up front, which can exceed
// what the browser will allocate for a multi-GB event log ("Array buffer
// allocation failed"). The codec is sniffed from the entry's first 8 bytes,
// falling back to the entry name's suffix.
// fflate's Gunzip and fzstd's Decompress are untyped vendor JS, so TS can't
// infer a construct signature for them; this local shape types the call sites
// without touching the vendored files.
type StreamingDecoder = { push(chunk: Uint8Array, final?: boolean): void };
type StreamingDecoderCtor = new (onChunk: (chunk: Uint8Array) => void) => StreamingDecoder;
type CodecSink = { push(chunk: Uint8Array, final: boolean): void | Promise<void>; cancel?(): void };

function openCodecSink(
  codec: ReturnType<typeof sniffCodec>, name: string, onChunk: (chunk: Uint8Array) => void, zstdDecoder?: ZstdDecoderFactory,
): CodecSink {
  if (codec === 'lz4' || name.endsWith('.lz4')) {
    const lz4 = createLz4BlockDecoder(onChunk);
    return { push(chunk, final) { lz4.push(chunk); if (final) lz4.end(); } };
  }
  if (codec === 'gz' || name.endsWith('.gz')) {
    const gunzip = new (Gunzip as unknown as StreamingDecoderCtor)(onChunk);
    return { push: (chunk, final) => gunzip.push(chunk, final) };
  }
  if (codec === 'zstd' || name.endsWith('.zstd') || name.endsWith('.zst')) {
    const zstd = zstdDecoder ? zstdDecoder(onChunk) : new (ZstdDecompress as unknown as StreamingDecoderCtor)(onChunk);
    return { push: (chunk, final) => zstd.push(chunk, final), cancel: () => (zstd as { cancel?(): void }).cancel?.() };
  }
  if (codec === 'snappy' || name.endsWith('.snappy')) {
    const snappy = createSnappyBlockDecoder(onChunk);
    return { push(chunk, final) { snappy.push(chunk); if (final) snappy.end(); } };
  }
  return { push: (chunk) => onChunk(chunk) };
}

// Wraps openCodecSink for a stream of unknown length: holds back the latest
// chunk so the last one can be pushed with `final` set (codecs reject a
// trailing empty push less uniformly than a real last chunk), and buffers the
// start of the entry until it has the 8 bytes sniffCodec needs.
function createEntryDecoder(name: string, onChunk: (chunk: Uint8Array) => void, zstdDecoder?: ZstdDecoderFactory) {
  let head = new Uint8Array(0);
  let held: Uint8Array | null = null;
  let sink: CodecSink | null = null;
  const open = () => {
    sink = openCodecSink(sniffCodec(head), name, onChunk, zstdDecoder);
    held = head;
  };
  return {
    async push(chunk: Uint8Array): Promise<void> {
      if (!sink) {
        const joined = new Uint8Array(head.length + chunk.length);
        joined.set(head);
        joined.set(chunk, head.length);
        head = joined;
        if (head.length >= 8) open();
        return;
      }
      await sink.push(held!, false);
      held = chunk;
    },
    async end(): Promise<void> {
      if (!sink) {
        if (!head.length) return;
        open();
      }
      await sink!.push(held!, true);
    },
    cancel(): void { sink?.cancel?.(); },
  };
}

type EmitFn = (msg: unknown) => void;

function emitShsError(emit: EmitFn, code: string): void {
  emit({ type: 'error', source: 'shs', code });
}

export async function runParseFromUrl(
  request: unknown,
  state: ParserState,
  { fetchImpl = fetch, emit = (msg: unknown) => self.postMessage(msg) }: { fetchImpl?: typeof fetch; emit?: EmitFn } = {}
): Promise<void> {
  // buildProxyRequestUrl is untyped JS; `request`'s real shape isn't pinned here.
  const url = buildProxyRequestUrl(request as Parameters<typeof buildProxyRequestUrl>[0]);

  let res;
  try {
    res = await fetchImpl(url);
  } catch {
    emitShsError(emit, 'local-server-unavailable');
    return;
  }
  if (res.status === 404) {
    emitShsError(emit, 'local-server-unavailable');
    return;
  }
  if (!res.ok) {
    let code = 'access-or-upstream-failure';
    try {
      const body = ShsProxyErrorBodySchema.parse(await res.json());
      if (isShsErrorCode(body.code)) code = body.code;
    } catch { /* Malformed proxy errors, or a body that fails schema validation, retain the generic safe code: same silent-skip treatment as a log-line validation failure. */ }
    emitShsError(emit, code);
    return;
  }

  if (!res.body) {
    emitShsError(emit, 'invalid-event-log');
    return;
  }

  let zipBytes;
  let total;
  try {
    total = Number(res.headers.get('content-length')) || null;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (!total || received < total) {
        emit({ type: 'progress', pct: total ? (received / total) * 0.5 : null, linesProcessed: 0 });
      }
    }
    zipBytes = new Uint8Array(received);
    let writeOffset = 0;
    for (const chunk of chunks) { zipBytes.set(chunk, writeOffset); writeOffset += chunk.length; }
  } catch {
    emitShsError(emit, 'local-server-unavailable');
    return;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.startsWith('text/html')) {
    emitShsError(emit, 'local-server-unavailable');
    return;
  }

  // The in-loop guard above intentionally withholds the tick for the chunk that
  // completes the download (received === total), to avoid double-emitting it here.
  // Emit it now that we know the download is complete: this is the one place a
  // determinate download is guaranteed to reach pct 0.5. Indeterminate downloads
  // (no Content-Length) already got their final tick from inside the loop, since
  // the loop's guard never withholds when total is null.
  if (total) {
    emit({ type: 'progress', pct: 0.5, linesProcessed: 0 });
  }
  await decodeShsArchive(zipBytes, state, emit);
}

// Reads the in-memory SHS download through the same random-access interface a
// dropped File offers, so both paths share parseZipArchive.
function bytesZipSource(bytes: Uint8Array): ZipSource {
  return {
    size: bytes.length,
    slice: (start, end) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
  };
}

export function decodeShsArchive(
  zipBytes: Uint8Array, state: ParserState, emit: EmitFn, { zstdDecoder }: { zstdDecoder?: ZstdDecoderFactory } = {},
): Promise<void> {
  return parseZipArchive(bytesZipSource(zipBytes), state, emit, {
    zstdDecoder,
    onInvalid: () => emitShsError(emit, 'invalid-event-log'),
  });
}

// The event-log entries a History Server zip holds, in parse order. A rolling
// log's parts sit under an `eventlog_v2_<appId>/` directory entry; they are
// matched and reassembled by base name. A single-file log is one entry at the
// root. Directory entries and the rolling log's `appstatus` marker are skipped.
function selectLogEntries(entries: ZipEntry[]): ZipEntry[] {
  const files = entries.filter((e) => !e.name.endsWith('/'));
  const baseName = (e: ZipEntry) => e.name.slice(e.name.lastIndexOf('/') + 1);
  if (files.some((e) => /^events_\d+_/.test(baseName(e)))) {
    const byBase = new Map(files.map((e) => [baseName(e), e]));
    return reassembleRollingEntries(files.map(baseName)).map((n) => byBase.get(n)!);
  }
  return files
    .filter((e) => baseName(e).toLowerCase() !== 'appstatus')
    .sort((a, b) => naturalCompare(a.name, b.name));
}

export interface ZipParseOpts {
  zstdDecoder?: ZstdDecoderFactory;
  chunkSize?: number;
  /** Reports an unusable archive. `detail` is null when the archive decoded
   * but held no application-start event. Called at most once, and nothing is
   * emitted after it. */
  onInvalid: (detail: string | null) => void;
  /** Lines between progress messages. */
  progressEvery?: number;
  /** Report pct as the fraction of compressed bytes read; otherwise null. */
  reportPct?: boolean;
}

// Parses a single-entry or rolling Spark History Server zip, streaming each
// entry out of `source` in `chunkSize` slices. One NDJSON line decoder spans
// all entries, since a file-roll boundary need not fall on a line boundary.
export async function parseZipArchive(
  source: ZipSource,
  state: ParserState,
  emit: EmitFn,
  { zstdDecoder, chunkSize = 512 * 1024, onInvalid, progressEvery = 2000, reportPct = false }: ZipParseOpts,
): Promise<void> {
  let logEntries: ZipEntry[];
  try {
    logEntries = selectLogEntries(await listZipEntries(source));
  } catch (e) {
    onInvalid(`Could not read the zip archive: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (logEntries.length === 0) {
    onInvalid('The zip archive contains no event log.');
    return;
  }

  const totalBytes = logEntries.reduce((sum, e) => sum + e.compressedSize, 0);
  let bytesRead = 0;
  const decoder = buildChunkDecoder();
  const joined: JoinedLine[] = [];
  let linesProcessed = 0;
  const feed = (bytes: Uint8Array) => {
    joined.length = 0;
    const lines = decoder.decode(bytes, joined);
    for (let i = 0, j = 0; i < lines.length; i++) {
      dispatchLine(lines[i], state, emit, joined[j]?.index === i ? joined[j++] : undefined);
      linesProcessed++;
      if (linesProcessed % progressEvery === 0) {
        emit({ type: 'progress', pct: reportPct && totalBytes ? bytesRead / totalBytes : null, linesProcessed });
      }
    }
  };

  for (const entry of logEntries) {
    const entryDecoder = createEntryDecoder(entry.name, feed, zstdDecoder);
    try {
      await streamZipEntry(source, entry, (chunk) => entryDecoder.push(chunk), {
        chunkSize,
        onRead: (bytes) => { bytesRead += bytes; },
      });
      await entryDecoder.end();
    } catch (e) {
      entryDecoder.cancel();
      onInvalid(`Could not decompress "${entry.name}" in the zip archive: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
  for (const line of decoder.flush()) {
    dispatchLine(line, state, emit);
  }

  if (!state.app) {
    onInvalid(null);
    return;
  }
  emitParseCompletion(state, emit, linesProcessed);
}
