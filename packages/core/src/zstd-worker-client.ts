// Parse-worker side of the zstd decompress worker (zstd-worker.ts). Builds a ZstdDecoderFactory
// for streamFile whose push() ships each compressed read slice to the decompress worker and
// returns while the worker decodes it, so the parse worker parses slice N's output while the
// decompress worker decodes slice N+1.
//
// Flow control is a window of input slices: push() resolves once fewer than `maxInFlight`
// slices are unacknowledged, and a slice is acknowledged only when its `consumed` reply is
// handled, which comes after all of its decoded chunks (each fed to onChunk from the message
// handler). So at most `maxInFlight` slices' output is ever queued on the parse worker, and a
// fast decompressor on a slow parse cannot grow memory without bound. The final push resolves
// only after every chunk was fed, which is what streamFile's callers need before they flush.
//
// Buffers move by transfer both ways: push() takes ownership of the slice it is given.
import type { ZstdDecoderFactory } from './parser-worker.ts';
import type { ZstdWorkerReply, ZstdWorkerRequest } from './zstd-worker.ts';

// Three 512 KiB slices of a ~20x-compressed log keep about 30 MB of output queued at most,
// and give the decompress worker a slice of slack while the parse worker reads the next one.
export const MAX_IN_FLIGHT_SLICES = 3;

// The slice of the Worker API this client uses; tests pass a MessagePort adapter.
export interface ZstdWorkerPort {
  postMessage(msg: ZstdWorkerRequest, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ZstdWorkerReply>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  terminate?(): void;
}

export interface WorkerZstdDecoderOptions {
  maxInFlight?: number;
  // Reports why decoding fell back to the parse worker's thread.
  onFallback?: (reason: string) => void;
}

type Stream = {
  id: number;
  onReply(msg: ZstdWorkerReply): void;
  fail(err: Error): void;
};

// `spawn` starts the decompress worker; it runs at most once, on the first zstd stream, and the
// worker then serves every later stream (the files of a rolling log) one at a time. When it
// cannot start (no nested workers, a blocked script, a crash), each stream is decoded by
// `fallback` on the calling thread instead, the path used before this worker existed.
export function createWorkerZstdDecoders(
  spawn: () => ZstdWorkerPort,
  fallback: ZstdDecoderFactory,
  { maxInFlight = MAX_IN_FLIGHT_SLICES, onFallback }: WorkerZstdDecoderOptions = {},
): ZstdDecoderFactory {
  let port: ZstdWorkerPort | null = null;
  let ready: Promise<boolean> | null = null;
  let active: Stream | null = null;
  let nextId = 0;

  const giveUp = (reason: string) => {
    port?.terminate?.();
    port = null;
    ready = Promise.resolve(false);
    onFallback?.(reason);
  };

  const startWorker = (): Promise<boolean> => new Promise((resolve) => {
    let candidate: ZstdWorkerPort;
    try {
      candidate = spawn();
    } catch (e) {
      giveUp(`could not start the decompress worker: ${e instanceof Error ? e.message : String(e)}`);
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok: boolean, reason = '') => {
      if (settled) return;
      settled = true;
      if (ok) port = candidate;
      else {
        candidate.terminate?.();
        giveUp(reason);
      }
      resolve(ok);
    };
    candidate.onmessage = ({ data }) => {
      if (data.type === 'ready') settle(true);
      else if (active && 'id' in data && data.id === active.id) active.onReply(data);
    };
    candidate.onerror = (ev) => {
      // Handled here: left alone, a nested worker's error also reaches the parse worker's own
      // global handler and from there the page's "Worker crashed" path.
      ev.preventDefault();
      const message = ev.message || 'unknown error';
      if (!settled) {
        settle(false, `the decompress worker failed to load: ${message}`);
        return;
      }
      const stream = active;
      giveUp(`the decompress worker crashed: ${message}`);
      stream?.fail(new Error(`Decompress worker crashed: ${message}`));
    };
  });

  return (onChunk) => {
    const id = nextId++;
    let started = false;
    let local: ReturnType<ZstdDecoderFactory> | null = null;
    let seq = 0;
    let inFlight = 0;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;

    const until = (done: () => boolean) => new Promise<void>((resolve) => {
      const check = () => {
        if (!done()) return;
        wake = null;
        resolve();
      };
      wake = check;
      check();
    });

    const stream: Stream = {
      id,
      onReply(msg) {
        if (failure) return;
        if (msg.type === 'chunk') {
          try {
            onChunk(new Uint8Array(msg.bytes, 0, msg.length));
          } catch (e) {
            port?.postMessage({ type: 'cancel', id }, []);
            stream.fail(e instanceof Error ? e : new Error(String(e)));
          }
        } else if (msg.type === 'consumed') {
          inFlight--;
          wake?.();
        } else if (msg.type === 'error') {
          stream.fail(new Error(msg.message));
        }
      },
      fail(err) {
        if (failure) return;
        failure = err;
        if (active === stream) active = null;
        wake?.();
      },
    };

    const begin = async () => {
      started = true;
      ready ??= startWorker();
      if (!(await ready) || !port) {
        local = fallback(onChunk);
        return;
      }
      active = stream;
      port.postMessage({ type: 'start', id }, []);
    };

    return {
      async push(chunk, final = false) {
        if (!started) await begin();
        if (local) return local.push(chunk, final);
        if (failure) throw failure;
        // Transfer the slice's own buffer when it spans all of it; copy a view of a larger one.
        const bytes = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
          ? chunk.buffer as ArrayBuffer
          : chunk.slice().buffer;
        if (!port) throw new Error('Decompress worker is gone');
        port.postMessage({ type: 'data', id, seq: seq++, bytes, final }, [bytes]);
        inFlight++;
        await until(() => failure !== null || inFlight < (final ? 1 : maxInFlight));
        if (failure) throw failure;
        if (final && active === stream) active = null;
      },
      cancel() {
        if (local || !started || failure) return;
        port?.postMessage({ type: 'cancel', id }, []);
        stream.fail(new Error('Decompression cancelled'));
      },
    };
  };
}
