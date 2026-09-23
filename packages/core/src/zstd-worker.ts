// Decompress worker: runs the vendored fzstd off the parse worker's thread, so decompression and
// NDJSON parsing of a zstd log overlap instead of taking turns. The parse worker spawns it and
// drives it through zstd-worker-client.ts; both ends of the message protocol live in the types
// below, and zstd-worker-client.ts documents the flow control.
import { Decompress as ZstdDecompress } from './vendor/fzstd.js';

// Parse worker -> decompress worker. `seq` numbers a stream's input slices from 0.
export type ZstdWorkerRequest =
  | { type: 'start'; id: number }
  | { type: 'data'; id: number; seq: number; bytes: ArrayBuffer; final: boolean }
  | { type: 'cancel'; id: number };

// Decompress worker -> parse worker. Every `chunk` for input slice `seq` is posted before that
// slice's `consumed`, and a stream's `error` is the last message it gets.
export type ZstdWorkerReply =
  | { type: 'ready' }
  | { type: 'chunk'; id: number; bytes: ArrayBuffer; length: number }
  | { type: 'consumed'; id: number; seq: number }
  | { type: 'error'; id: number; message: string };

export type ZstdWorkerPost = (msg: ZstdWorkerReply, transfer?: Transferable[]) => void;

// fzstd emits one chunk per zstd block (128 KiB at most). Batching them into 1 MiB messages cuts
// the per-message cost on both threads about eight-fold.
export const OUTPUT_BATCH_BYTES = 1024 * 1024;

type StreamingDecoder = { push(chunk: Uint8Array, final?: boolean): void };
type StreamingDecoderCtor = new (onChunk: (chunk: Uint8Array) => void) => StreamingDecoder;

// The decompress side of the protocol, transport-free so tests can drive it over a
// MessageChannel. Holds at most one live stream: `start` replaces it, and a message for any
// other stream id (one already cancelled or failed) is dropped.
export function createZstdWorkerHandler(
  post: ZstdWorkerPost,
  batchBytes: number = OUTPUT_BATCH_BYTES,
): (msg: ZstdWorkerRequest) => void {
  let streamId = -1;
  let decoder: StreamingDecoder | null = null;
  let batch = new Uint8Array(batchBytes);
  let batchUsed = 0;

  // Hand `batch` over without copying it again: transfer its whole buffer with the filled
  // length and start a fresh one. fzstd's chunk is a view of a buffer it reuses, so the copy
  // into `batch` is the one copy this path cannot avoid.
  const flush = () => {
    if (batchUsed === 0) return;
    const bytes = batch.buffer as ArrayBuffer;
    post({ type: 'chunk', id: streamId, bytes, length: batchUsed }, [bytes]);
    batch = new Uint8Array(batchBytes);
    batchUsed = 0;
  };

  const collect = (chunk: Uint8Array) => {
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(chunk.length - offset, batchBytes - batchUsed);
      batch.set(chunk.subarray(offset, offset + n), batchUsed);
      batchUsed += n;
      offset += n;
      if (batchUsed === batchBytes) flush();
    }
  };

  const reset = () => {
    decoder = null;
    batchUsed = 0;
  };

  return (msg) => {
    if (msg.type === 'start') {
      streamId = msg.id;
      batchUsed = 0;
      decoder = new (ZstdDecompress as unknown as StreamingDecoderCtor)(collect);
      return;
    }
    if (msg.id !== streamId || !decoder) return;
    if (msg.type === 'cancel') {
      reset();
      return;
    }
    try {
      decoder.push(new Uint8Array(msg.bytes), msg.final);
      flush();
    } catch (e) {
      reset();
      post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    post({ type: 'consumed', id: msg.id, seq: msg.seq });
    if (msg.final) reset();
  };
}

// ─── Worker message bus (only active when running as a Web Worker) ──────────────

const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

if (isWorker) {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  const handle = createZstdWorkerHandler((msg, transfer) => scope.postMessage(msg, transfer ?? []));
  scope.onmessage = ({ data }: MessageEvent<ZstdWorkerRequest>) => handle(data);
  scope.postMessage({ type: 'ready' } satisfies ZstdWorkerReply);
}
