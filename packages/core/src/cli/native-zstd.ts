// Node-only zstd decoding for the CLI/MCP parse path: Node's native zlib zstd, one frame at a
// time, with the vendored fzstd (what the browser uses) as the fallback.
//
// Spark writes an event log as thousands of small zstd frames (one per flush: 10217 frames for
// the largest real log's 3.5 GB). Node's zstdDecompressSync and createZstdDecompress both stop
// after the first frame (the stream then fails with "Unknown frame descriptor"), so this walks
// frame boundaries itself and decompresses each complete frame natively: 3-5x faster than fzstd
// on the real logs (5.6s -> 1.3-1.8s on the largest).
import * as zlib from 'node:zlib';
import { Decompress as ZstdDecompress } from '../vendor/fzstd.js';

type StreamingDecoder = { push(chunk: Uint8Array, final?: boolean): void };
type StreamingDecoderCtor = new (onChunk: (chunk: Uint8Array) => void) => StreamingDecoder;

// zstdDecompressSync materializes a whole frame, so a frame declaring more content than this, or
// still incomplete after this many compressed bytes, is streamed through fzstd instead: a log
// compressed as a single frame (the zstd CLI's default) must never be held whole in memory.
const MAX_NATIVE_FRAME_BYTES = 64 * 1024 * 1024;

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50;

const INCOMPLETE = -1;
const NOT_NATIVE = -2;

function readUint32LE(buf: Uint8Array, at: number): number {
  return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;
}

// End offset of the zstd or skippable frame starting at `off` (RFC 8878), INCOMPLETE when `buf`
// ends before it does, or NOT_NATIVE for a frame this path won't decode itself: oversized, or
// not a well-formed frame (fzstd then reports the corruption exactly as the browser would).
function frameEnd(buf: Uint8Array, off: number, maxFrameBytes: number): number {
  if (off + 4 > buf.length) return INCOMPLETE;
  const magic = readUint32LE(buf, off);
  if ((magic & 0xfffffff0) === SKIPPABLE_MAGIC) {
    if (off + 8 > buf.length) return INCOMPLETE;
    const end = off + 8 + readUint32LE(buf, off + 4);
    return end <= buf.length ? end : INCOMPLETE;
  }
  if (magic !== ZSTD_MAGIC) return NOT_NATIVE;
  let p = off + 4;
  if (p >= buf.length) return INCOMPLETE;
  const descriptor = buf[p++];
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  p += (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3];
  const contentSizeBytes = contentSizeFlag === 0 ? singleSegment : [0, 2, 4, 8][contentSizeFlag];
  if (p + contentSizeBytes > buf.length) return INCOMPLETE;
  const contentSize =
    contentSizeBytes === 1 ? buf[p]
      : contentSizeBytes === 2 ? (buf[p] | (buf[p + 1] << 8)) + 256
        : contentSizeBytes === 4 ? readUint32LE(buf, p)
          : contentSizeBytes === 8 ? readUint32LE(buf, p) + readUint32LE(buf, p + 4) * 2 ** 32
            : 0;
  if (contentSize > maxFrameBytes) return NOT_NATIVE;
  p += contentSizeBytes;
  for (;;) {
    if (p + 3 > buf.length) return INCOMPLETE;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const blockType = (header >> 1) & 3;
    if (blockType === 3) return NOT_NATIVE; // reserved: corrupt data
    p += blockType === 1 ? 1 : header >> 3; // an RLE block stores its one repeated byte
    if (p > buf.length) return INCOMPLETE;
    if (header & 1) break; // last block
  }
  p += hasChecksum ? 4 : 0;
  return p <= buf.length ? p : INCOMPLETE;
}

export const nativeZstdAvailable =
  typeof zlib.zstdDecompressSync === 'function' && typeof zlib.createZstdDecompress === 'function';

// Same push(chunk, final) contract as fzstd's Decompress. Once a frame falls back, fzstd takes
// the rest of the stream from that frame's first byte; a truncated last frame goes to fzstd too,
// so it fails with fzstd's own "unexpected EOF", as it always has. `maxFrameBytes` is for tests.
export function createNativeZstdDecoder(
  onChunk: (chunk: Uint8Array) => void,
  { maxFrameBytes = MAX_NATIVE_FRAME_BYTES }: { maxFrameBytes?: number } = {},
): { push(chunk: Uint8Array, final?: boolean): undefined } {
  let pending: Uint8Array | null = null;
  let fallback: StreamingDecoder | null = null;
  const toFallback = (bytes: Uint8Array, final: boolean): void => {
    fallback ??= new (ZstdDecompress as unknown as StreamingDecoderCtor)(onChunk);
    fallback.push(bytes, final);
  };
  return {
    push(chunk: Uint8Array, final = false): undefined {
      if (fallback) { fallback.push(chunk, final); return; }
      let buf = chunk;
      if (pending) {
        buf = new Uint8Array(pending.length + chunk.length);
        buf.set(pending);
        buf.set(chunk, pending.length);
        pending = null;
      }
      let off = 0;
      while (off < buf.length) {
        const end = frameEnd(buf, off, maxFrameBytes);
        if (end === NOT_NATIVE || (end === INCOMPLETE && buf.length - off > maxFrameBytes)) {
          toFallback(buf.subarray(off), final);
          return;
        }
        if (end === INCOMPLETE) break;
        if (readUint32LE(buf, off) === ZSTD_MAGIC) onChunk(zlib.zstdDecompressSync(buf.subarray(off, end)));
        off = end;
      }
      if (off < buf.length) {
        if (final) toFallback(buf.subarray(off), true);
        else pending = buf.slice(off);
      }
    },
  };
}

// Frames at least this big (compressed) are decompressed on libuv's threadpool, up to
// MAX_FRAMES_IN_FLIGHT at a time, while the main thread parses the output of earlier ones.
// Smaller frames cost less to decompress inline than to hand off (p50 is 5.8 KB of output on the
// largest real log; 16-64 KB thresholds measured the same, 256 KB lost most of the gain). On that
// log 4 in flight (the pool's default size) parsed in 3.1s at 711 MB peak RSS, 8 in 3.2s at 886 MB
// and 2 in 3.5s at 607 MB. The pool's output chunk size barely mattered (64 KB to 1 MB).
const THREADED_MIN_FRAME_BYTES = 64 * 1024;
const MAX_FRAMES_IN_FLIGHT = 4;
const THREADED_CHUNK_BYTES = 256 * 1024;
// Small frames that arrive while an earlier frame is in flight wait in the queue behind it. With
// no cap, a first version held most of the largest real log's output (RSS 0.6 -> 4.1 GB).
const MAX_QUEUED_FRAMES = 64;

// Node's zstd stream ends after one frame, so each frame gets its own. Its output chunks are kept
// as they are: zstdDecompressSync would copy them into one buffer on the main thread.
function decompressOffThread(frame: Uint8Array): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const stream = zlib.createZstdDecompress({ chunkSize: THREADED_CHUNK_BYTES });
    stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    stream.on('end', () => resolve(chunks));
    stream.on('error', reject);
    stream.end(frame);
  });
}

// createNativeZstdDecoder's contract, with large frames decompressed in parallel off the main
// thread: push() resolves once its complete frames are queued (or delivered, when the queue is
// full), and a final push resolves after every chunk has reached onChunk, in stream order. Each
// push must be awaited before the next. It keeps references to pushed bytes until their frames
// are decoded, so callers must not reuse a pushed buffer. Fallback to fzstd, for the same frames
// as createNativeZstdDecoder, happens only after every queued frame is delivered; a failed frame
// rejects the push that reaches it. `threadedMinFrameBytes` is for tests. Measured on the 14 real
// logs: parse 9.4s -> 8.1s; logs with few large frames (12 of 6455 on a 28 MB one) gain nothing.
export function createThreadedZstdDecoder(
  onChunk: (chunk: Uint8Array) => void,
  { maxFrameBytes = MAX_NATIVE_FRAME_BYTES, threadedMinFrameBytes = THREADED_MIN_FRAME_BYTES }:
    { maxFrameBytes?: number; threadedMinFrameBytes?: number } = {},
): { push(chunk: Uint8Array, final?: boolean): Promise<void> } {
  let pending: Uint8Array | null = null;
  let fallback: StreamingDecoder | null = null;
  // Frames not yet delivered, oldest first: off-thread output, or a small frame still compressed,
  // decompressed inline only when its turn comes so its output is fresh in cache for the parse.
  type Queued = { output: Promise<Uint8Array[]>; frame?: never } | { frame: Uint8Array; output?: never };
  const queued: Queued[] = [];
  let threadedQueued = 0;
  const deliverOldest = async (): Promise<void> => {
    const entry = queued.shift()!;
    if (entry.frame) { onChunk(zlib.zstdDecompressSync(entry.frame)); return; }
    threadedQueued--;
    for (const chunk of await entry.output!) onChunk(chunk);
  };
  const enqueue = async (entry: Queued): Promise<void> => {
    queued.push(entry);
    if (entry.output) threadedQueued++;
    while (threadedQueued >= MAX_FRAMES_IN_FLIGHT || queued.length >= MAX_QUEUED_FRAMES) await deliverOldest();
  };
  const deliverAll = async (): Promise<void> => {
    while (queued.length > 0) await deliverOldest();
  };
  const toFallback = async (bytes: Uint8Array, final: boolean): Promise<void> => {
    await deliverAll();
    fallback ??= new (ZstdDecompress as unknown as StreamingDecoderCtor)(onChunk);
    fallback.push(bytes, final);
  };
  return {
    async push(chunk: Uint8Array, final = false): Promise<void> {
      if (fallback) { fallback.push(chunk, final); return; }
      let buf = chunk;
      if (pending) {
        buf = new Uint8Array(pending.length + chunk.length);
        buf.set(pending);
        buf.set(chunk, pending.length);
        pending = null;
      }
      let off = 0;
      while (off < buf.length) {
        const end = frameEnd(buf, off, maxFrameBytes);
        if (end === NOT_NATIVE || (end === INCOMPLETE && buf.length - off > maxFrameBytes)) {
          await toFallback(buf.subarray(off), final);
          return;
        }
        if (end === INCOMPLETE) break;
        if (readUint32LE(buf, off) === ZSTD_MAGIC) {
          const frame = buf.subarray(off, end);
          if (frame.length >= threadedMinFrameBytes) {
            const output = decompressOffThread(frame);
            output.catch(() => {}); // rethrown where it's awaited; no unhandled rejection before then
            await enqueue({ output });
          } else if (queued.length === 0) {
            onChunk(zlib.zstdDecompressSync(frame));
          } else {
            await enqueue({ frame });
          }
        }
        off = end;
      }
      if (off < buf.length) {
        if (final) await toFallback(buf.subarray(off), true);
        else pending = buf.slice(off);
      } else if (final) {
        await deliverAll();
      }
    },
  };
}

// Node's native zstd where this Node has it (22.15+/23.8+); older Nodes keep the vendored fzstd.
// runParse/runParseFiles (collectRun) take the threaded decoder. decodeShsArchive decodes each
// archive entry in one synchronous call, so the SHS archive loader takes the inline one.
export const nodeParseCodecs: { zstdDecoder?: typeof createThreadedZstdDecoder } =
  nativeZstdAvailable ? { zstdDecoder: createThreadedZstdDecoder } : {};
export const nodeArchiveCodecs: { zstdDecoder?: typeof createNativeZstdDecoder } =
  nativeZstdAvailable ? { zstdDecoder: createNativeZstdDecoder } : {};
