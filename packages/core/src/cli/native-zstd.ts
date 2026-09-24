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
// compressed as a single frame (the zstd CLI's default) must never be held whole in memory. A
// frame that declares no size (every frame Spark writes, and `zstd < log > log.zst`) is decoded
// with its output capped at this: past it, it streams too (decompressBounded).
const MAX_NATIVE_FRAME_BYTES = 64 * 1024 * 1024;

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50;

const INCOMPLETE = -1;
const NOT_NATIVE = -2;

function readUint32LE(buf: Uint8Array, at: number): number {
  return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;
}

// Where a walk of an incomplete frame stopped, relative to the frame's first byte: `next` is the
// next block header (or the checksum once `blocksDone`), -1 while the frame header is incomplete.
interface FrameWalk { next: number; checksum: boolean; blocksDone: boolean }

const freshWalk = (): FrameWalk => ({ next: -1, checksum: false, blocksDone: false });

// End offset of the zstd or skippable frame starting at `off` (RFC 8878), INCOMPLETE when `buf`
// ends before it does, or NOT_NATIVE for a frame this path won't decode itself: oversized, or
// not a well-formed frame (fzstd then reports the corruption exactly as the browser would). An
// INCOMPLETE walk leaves its place in `walk`, so the next call on more of the frame resumes there.
function frameEnd(buf: Uint8Array, off: number, maxFrameBytes: number, walk: FrameWalk = freshWalk()): number {
  let p: number;
  let hasChecksum: boolean;
  if (walk.next >= 0) {
    p = off + walk.next;
    hasChecksum = walk.checksum;
  } else {
    if (off + 4 > buf.length) return INCOMPLETE;
    const magic = readUint32LE(buf, off);
    if ((magic & 0xfffffff0) === SKIPPABLE_MAGIC) {
      if (off + 8 > buf.length) return INCOMPLETE;
      const end = off + 8 + readUint32LE(buf, off + 4);
      return end <= buf.length ? end : INCOMPLETE;
    }
    if (magic !== ZSTD_MAGIC) return NOT_NATIVE;
    p = off + 4;
    if (p >= buf.length) return INCOMPLETE;
    const descriptor = buf[p++];
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    hasChecksum = ((descriptor >> 2) & 1) === 1;
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
    walk.checksum = hasChecksum;
  }
  while (!walk.blocksDone) {
    walk.next = p - off;
    if (p + 3 > buf.length) return INCOMPLETE;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const blockType = (header >> 1) & 3;
    if (blockType === 3) return NOT_NATIVE; // reserved: corrupt data
    p += blockType === 1 ? 1 : header >> 3; // an RLE block stores its one repeated byte
    if (p > buf.length) return INCOMPLETE;
    if (header & 1) { // last block
      walk.blocksDone = true;
      walk.next = p - off;
    }
  }
  p += hasChecksum ? 4 : 0;
  return p <= buf.length ? p : INCOMPLETE;
}

export const nativeZstdAvailable =
  typeof zlib.zstdDecompressSync === 'function' && typeof zlib.createZstdDecompress === 'function';

// One step of FrameSplitter.split: a whole frame (`data` false for a skippable one), or the bytes
// from a frame this path won't decode natively to the end of the push, which fzstd then takes.
type SplitStep = { frame: Uint8Array; data: boolean; fallback?: never } | { fallback: Uint8Array; frame?: never };

// Splits a zstd byte stream into whole frames as it arrives, for both decoders below. A frame
// falls back to fzstd when frameEnd says NOT_NATIVE, when it is still incomplete after
// `maxFrameBytes` compressed bytes, or when a final push ends inside it. A frame that arrives
// over many pushes is gathered into one buffer that grows by doubling, and its walk resumes where
// the last push left it: copying the gathered bytes into a new buffer and walking the frame from
// its start on every push cost about 4 GB of copying near the 64 MB limit.
class FrameSplitter {
  // The incomplete frame's bytes so far, gathered[0, gatheredLength); null when none is pending.
  private gathered: Uint8Array | null = null;
  private gatheredLength = 0;
  private walk: FrameWalk = freshWalk();
  private readonly maxFrameBytes: number;
  // The current push's bytes after the last frame split() yielded, for rest().
  private current: Uint8Array = new Uint8Array(0);
  private restAt = 0;

  constructor(maxFrameBytes: number) {
    this.maxFrameBytes = maxFrameBytes;
  }

  private gather(bytes: Uint8Array): Uint8Array {
    const length = this.gatheredLength + bytes.length;
    if (this.gathered === null || length > this.gathered.length) {
      const grown = new Uint8Array(Math.max(length, (this.gathered?.length ?? 0) * 2));
      if (this.gathered !== null) grown.set(this.gathered.subarray(0, this.gatheredLength));
      this.gathered = grown;
    }
    this.gathered.set(bytes, this.gatheredLength);
    this.gatheredLength = length;
    return this.gathered.subarray(0, length);
  }

  // Frames and fallback bytes yielded from a gathered buffer stay valid: a completed buffer is
  // dropped, never reused.
  *split(chunk: Uint8Array, final: boolean): Generator<SplitStep> {
    let off = 0;
    if (this.gathered !== null) {
      const held = this.gather(chunk);
      const end = frameEnd(held, 0, this.maxFrameBytes, this.walk);
      if (end === INCOMPLETE && held.length <= this.maxFrameBytes && !final) return;
      this.gathered = null;
      this.gatheredLength = 0;
      if (end === NOT_NATIVE || end === INCOMPLETE) {
        yield { fallback: held };
        return;
      }
      off = chunk.length - (held.length - end); // the rest of the chunk follows that frame
      this.current = chunk;
      this.restAt = off;
      yield { frame: held.subarray(0, end), data: readUint32LE(held, 0) === ZSTD_MAGIC };
    }
    while (off < chunk.length) {
      this.walk = freshWalk();
      const end = frameEnd(chunk, off, this.maxFrameBytes, this.walk);
      if (end === NOT_NATIVE || (end === INCOMPLETE && chunk.length - off > this.maxFrameBytes)) {
        yield { fallback: chunk.subarray(off) };
        return;
      }
      if (end === INCOMPLETE) break;
      this.current = chunk;
      this.restAt = end;
      yield { frame: chunk.subarray(off, end), data: readUint32LE(chunk, off) === ZSTD_MAGIC };
      off = end;
    }
    if (off < chunk.length) {
      if (final) yield { fallback: chunk.subarray(off) };
      else this.gather(chunk.subarray(off));
    }
  }

  // The current push's bytes after the frame split() last yielded, for a caller that stops there
  // and hands the rest of the stream to fzstd. The splitter is not used after this.
  rest(): Uint8Array {
    return this.current.subarray(this.restAt);
  }
}

// A frame's output, or null when it would pass `maxBytes`: without a declared content size
// nothing else bounds it, and zstdDecompressSync would build the whole thing as one buffer.
function decompressBounded(frame: Uint8Array, maxBytes: number): Uint8Array | null {
  try {
    return zlib.zstdDecompressSync(frame, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') return null;
    throw err;
  }
}

// Same push(chunk, final) contract as fzstd's Decompress. Once a frame falls back, fzstd takes
// the rest of the stream from that frame's first byte; a truncated last frame goes to fzstd too,
// so it fails with fzstd's own "unexpected EOF", as it always has. `maxFrameBytes` is for tests.
export function createNativeZstdDecoder(
  onChunk: (chunk: Uint8Array) => void,
  { maxFrameBytes = MAX_NATIVE_FRAME_BYTES }: { maxFrameBytes?: number } = {},
): { push(chunk: Uint8Array, final?: boolean): undefined } {
  const splitter = new FrameSplitter(maxFrameBytes);
  let fallback: StreamingDecoder | null = null;
  const toFallback = (bytes: Uint8Array, final: boolean): void => {
    fallback ??= new (ZstdDecompress as unknown as StreamingDecoderCtor)(onChunk);
    fallback.push(bytes, final);
  };
  return {
    push(chunk: Uint8Array, final = false): undefined {
      if (fallback) { fallback.push(chunk, final); return; }
      for (const step of splitter.split(chunk, final)) {
        if (step.fallback) { toFallback(step.fallback, final); return; }
        if (!step.data) continue;
        const output = decompressBounded(step.frame, maxFrameBytes);
        if (output) { onChunk(output); continue; }
        // Past the bound: fzstd streams this frame block by block, then the rest of the stream.
        toFallback(step.frame, false);
        toFallback(splitter.rest(), final);
        return;
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

// One frame decompressing on the threadpool. Node's zstd stream ends after one frame, so each
// frame gets its own. Its output chunks are kept as they are (zstdDecompressSync would copy them
// into one buffer on the main thread) until deliver() hands them over, in its turn. Up to
// `maxBufferedBytes` of them wait; then the stream pauses until deliver() drains them, so a frame
// without a declared size is never held whole.
class OffThreadFrame {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private ended = false;
  private error: unknown = null;
  private wake: (() => void) | null = null;
  private readonly stream: ReturnType<typeof zlib.createZstdDecompress>;

  constructor(frame: Uint8Array, maxBufferedBytes: number) {
    this.stream = zlib.createZstdDecompress({ chunkSize: THREADED_CHUNK_BYTES });
    this.stream.on('data', (chunk: Uint8Array) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      if (this.buffered >= maxBufferedBytes) this.stream.pause();
      this.signal();
    });
    this.stream.on('end', () => { this.ended = true; this.signal(); });
    // Kept until deliver() reaches it: rethrown there, never an unhandled error before then.
    this.stream.on('error', (err: unknown) => { this.error = err; this.ended = true; this.signal(); });
    this.stream.end(frame);
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async deliver(onChunk: (chunk: Uint8Array) => void): Promise<void> {
    for (;;) {
      const ready = this.chunks;
      this.chunks = [];
      this.buffered = 0;
      for (const chunk of ready) onChunk(chunk);
      if (this.error !== null) throw this.error;
      if (this.ended) return;
      const more = new Promise<void>((resolve) => { this.wake = resolve; });
      this.stream.resume();
      await more;
    }
  }
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
  const splitter = new FrameSplitter(maxFrameBytes);
  let fallback: StreamingDecoder | null = null;
  // Frames not yet delivered, oldest first: off-thread output, or a small frame still compressed,
  // decompressed inline only when its turn comes so its output is fresh in cache for the parse.
  type Queued = { output: OffThreadFrame; frame?: never } | { frame: Uint8Array; output?: never };
  const queued: Queued[] = [];
  let threadedQueued = 0;
  // A small frame, inline; one whose output passes maxFrameBytes streams like an off-thread one.
  const deliverInline = async (frame: Uint8Array): Promise<void> => {
    const output = decompressBounded(frame, maxFrameBytes);
    if (output) onChunk(output);
    else await new OffThreadFrame(frame, maxFrameBytes).deliver(onChunk);
  };
  const deliverOldest = async (): Promise<void> => {
    const entry = queued.shift()!;
    if (entry.frame) { await deliverInline(entry.frame); return; }
    threadedQueued--;
    await entry.output!.deliver(onChunk);
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
      for (const step of splitter.split(chunk, final)) {
        if (step.fallback) { await toFallback(step.fallback, final); return; }
        if (!step.data) continue;
        const frame = step.frame;
        if (frame.length >= threadedMinFrameBytes) {
          await enqueue({ output: new OffThreadFrame(frame, maxFrameBytes) });
        } else if (queued.length === 0) {
          await deliverInline(frame);
        } else {
          await enqueue({ frame });
        }
      }
      if (final) await deliverAll();
    },
  };
}

// Node's native zstd where this Node has it (22.15+/23.8+); older Nodes keep the vendored fzstd.
// runParse/runParseFiles (collectRun) take the threaded decoder; the SHS archive loader
// (decodeShsArchive over an in-memory download) takes the inline one.
export const nodeParseCodecs: { zstdDecoder?: typeof createThreadedZstdDecoder } =
  nativeZstdAvailable ? { zstdDecoder: createThreadedZstdDecoder } : {};
export const nodeArchiveCodecs: { zstdDecoder?: typeof createNativeZstdDecoder } =
  nativeZstdAvailable ? { zstdDecoder: createNativeZstdDecoder } : {};
