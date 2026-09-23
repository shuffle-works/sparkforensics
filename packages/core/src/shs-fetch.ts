import { unzipSync, Gunzip } from './vendor/fflate.js';
import { createLz4BlockDecoder } from './lz4-block.ts';
import { Decompress as ZstdDecompress } from './vendor/fzstd.js';
import { createSnappyBlockDecoder } from './snappy-block.ts';
import { buildProxyRequestUrl, isShsErrorCode } from './shs-request.js';
import { dispatchLine, buildChunkDecoder, emitParseCompletion, type JoinedLine, type ParserState } from './event-handlers.ts';
import { ShsProxyErrorBodySchema } from './shs-schemas.ts';
import { naturalCompare, reassembleRollingEntries } from './rolling-log-reassembly.ts';

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

// Streams one already-in-memory zip entry through its codec's block-by-block
// decoder, invoking `onChunk` per decompressed piece; never materializes the
// whole decompressed entry as one buffer. A giant single-segment zstd frame
// (or gzip member) declares its full content size in the header; one-shotting
// it (fzstd's `decompress()`, fflate's `gunzipSync()`) allocates that entire
// size as a single ArrayBuffer up front, which can exceed what the browser
// will allocate for a multi-GB event log ("Array buffer allocation failed").
// fflate's Gunzip and fzstd's Decompress are untyped vendor JS, so TS can't
// infer a construct signature for them; this local shape types the call sites
// without touching the vendored files.
type StreamingDecoder = { push(chunk: Uint8Array, final?: boolean): void };
type StreamingDecoderCtor = new (onChunk: (chunk: Uint8Array) => void) => StreamingDecoder;
// Like parser-worker.ts's RunOpts.zstdDecoder, but synchronous: decodeEntry never awaits push(),
// so its result is typed `undefined` (not `void`, which would also accept an async decoder's
// Promise). Node callers pass cli/native-zstd.ts's createNativeZstdDecoder (nodeArchiveCodecs).
type ZstdDecoderFactory = (onChunk: (chunk: Uint8Array) => void) => { push(chunk: Uint8Array, final?: boolean): undefined };

function decodeEntry(
  name: string, raw: Uint8Array, onChunk: (chunk: Uint8Array) => void, zstdDecoder?: ZstdDecoderFactory,
): void {
  const codec = sniffCodec(raw);
  if (codec === 'lz4' || name.endsWith('.lz4')) {
    const lz4 = createLz4BlockDecoder(onChunk);
    lz4.push(raw);
    lz4.end();
  } else if (codec === 'gz' || name.endsWith('.gz')) {
    new (Gunzip as unknown as StreamingDecoderCtor)(onChunk).push(raw, true);
  } else if (codec === 'zstd' || name.endsWith('.zstd') || name.endsWith('.zst')) {
    (zstdDecoder ? zstdDecoder(onChunk) : new (ZstdDecompress as unknown as StreamingDecoderCtor)(onChunk)).push(raw, true);
  } else if (codec === 'snappy' || name.endsWith('.snappy')) {
    const snappy = createSnappyBlockDecoder(onChunk);
    snappy.push(raw);
    snappy.end();
  } else {
    onChunk(raw);
  }
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
  decodeShsArchive(zipBytes, state, emit);
}

export function decodeShsArchive(
  zipBytes: Uint8Array, state: ParserState, emit: EmitFn, { zstdDecoder }: { zstdDecoder?: ZstdDecoderFactory } = {},
): void {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    emitShsError(emit, 'invalid-event-log');
    return;
  }
  const allNames = Object.keys(entries);
  const isRolling = allNames.some(n => /^events_\d+_/.test(n));
  let names;
  if (isRolling) {
    try {
      names = reassembleRollingEntries(allNames);
    } catch {
      emitShsError(emit, 'invalid-event-log');
      return;
    }
  } else {
    names = allNames.filter(n => n.toLowerCase() !== 'appstatus').sort(naturalCompare);
  }
  if (names.length === 0) {
    emitShsError(emit, 'invalid-event-log');
    return;
  }

  const decoder = buildChunkDecoder();
  const joined: JoinedLine[] = [];
  let linesProcessed = 0;
  for (const name of names) {
    try {
      decodeEntry(name, entries[name], (bytes) => {
        joined.length = 0;
        const lines = decoder.decode(bytes, joined);
        for (let i = 0, j = 0; i < lines.length; i++) {
          dispatchLine(lines[i], state, emit, joined[j]?.index === i ? joined[j++] : undefined);
          linesProcessed++;
          if (linesProcessed % 2000 === 0) {
            emit({ type: 'progress', pct: null, linesProcessed });
          }
        }
      }, zstdDecoder);
    } catch {
      emitShsError(emit, 'invalid-event-log');
      return;
    }
  }
  for (const line of decoder.flush()) {
    dispatchLine(line, state, emit);
  }

  if (!state.app) {
    emitShsError(emit, 'invalid-event-log');
    return;
  }
  emitParseCompletion(state, emit, linesProcessed);
}
