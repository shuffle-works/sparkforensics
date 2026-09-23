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

export const nativeZstdAvailable = typeof zlib.zstdDecompressSync === 'function';

// Same push(chunk, final) contract as fzstd's Decompress. Once a frame falls back, fzstd takes
// the rest of the stream from that frame's first byte; a truncated last frame goes to fzstd too,
// so it fails with fzstd's own "unexpected EOF", as it always has. `maxFrameBytes` is for tests.
export function createNativeZstdDecoder(
  onChunk: (chunk: Uint8Array) => void,
  { maxFrameBytes = MAX_NATIVE_FRAME_BYTES }: { maxFrameBytes?: number } = {},
): StreamingDecoder {
  let pending: Uint8Array | null = null;
  let fallback: StreamingDecoder | null = null;
  const toFallback = (bytes: Uint8Array, final: boolean): void => {
    fallback ??= new (ZstdDecompress as unknown as StreamingDecoderCtor)(onChunk);
    fallback.push(bytes, final);
  };
  return {
    push(chunk: Uint8Array, final = false): void {
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

// The parse options every Node entry point (collectRun, the SHS archive loader) passes: Node's
// native zstd where this Node has it (22.15+/23.8+); older Nodes keep the vendored fzstd.
export const nodeParseCodecs: { zstdDecoder?: typeof createNativeZstdDecoder } =
  nativeZstdAvailable ? { zstdDecoder: createNativeZstdDecoder } : {};
