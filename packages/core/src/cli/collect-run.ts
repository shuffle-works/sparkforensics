import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createState, runParse, runParseFiles, reassembleRollingEntries } from '../parser-worker.ts';
import { nodeParseCodecs } from './native-zstd.ts';
import { createModelCallbacks } from '../model-assembler.ts';
import { routeMessage, type IngestHandlers } from '../ingest.ts';
import type { AppModel } from '../types.ts';

export interface FileLike {
  name: string; size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function emptyAppModel(): AppModel {
  return {
    app: null,
    stages: new Map(),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
  };
}

// File-like shape runParse/runParseFiles need: name, size, slice().arrayBuffer(), arrayBuffer().
export function nodeFileFromPath(path: string): FileLike {
  const bytes = readFileSync(path);
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    name: basename(path),
    size: u8.length,
    slice(start: number, end: number) {
      const view = u8.subarray(start, end);
      return { async arrayBuffer() { return view.slice().buffer; } };
    },
    async arrayBuffer() { return u8.slice().buffer; },
  };
}

// Lazy-loading variant for peekLogHeader: only reads the requested byte range from disk,
// avoiding eager full-file slurps for large logs during directory scans.
// Used by list_runs local-mode scanning; does NOT have arrayBuffer() since peekLogHeader
// only needs slice() for bounded reads of the file header.
export function nodeLazyPeekableFromPath(path: string): {
  name: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
} {
  const size = statSync(path).size;
  return {
    name: basename(path),
    size,
    slice(start: number, end: number) {
      return {
        async arrayBuffer(): Promise<ArrayBuffer> {
          const len = Math.max(0, Math.min(end, size) - start);
          if (len === 0) return new ArrayBuffer(0);
          const buf = Buffer.alloc(len);
          const fd = openSync(path, 'r');
          try {
            readSync(fd, buf, 0, len, start);
          } finally {
            closeSync(fd);
          }
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
      };
    },
  };
}

// routeMessage is the single source of truth for worker-message -> handler wiring, shared by
// the browser Worker and this Node CLI path. No pendingTaskRequests: the CLI never sends
// 'getTaskData', so never receives 'taskData' back.
export function dispatch(msg: unknown, handlers: IngestHandlers): void {
  routeMessage(msg as { type: string; [k: string]: unknown }, handlers);
}

export function isRollingLogDirectory(dirPath: string): boolean {
  const names = readdirSync(dirPath);
  return names.some((n: string) => /^events_\d+_/.test(n));
}

// Shared ingest scaffold for both routeMessage consumers (this file's collectRun over a
// local file/dir, shs-load.ts's collectShsAppModel over fetched bytes): each caller supplies
// its own decode step and error type via onDecodeError.
export function collectViaDispatch(
  run: (state: ReturnType<typeof createState>, emit: (msg: unknown) => void, reject: (reason?: unknown) => void) => void,
  onDecodeError: (msg: unknown) => Error,
): Promise<{ appModel: AppModel; skippedLines: number }> {
  const appModel = emptyAppModel();
  const cb = createModelCallbacks(appModel, { onProgress() {}, onDone() {}, onError() {} });

  return new Promise((resolve, reject) => {
    const handlers: IngestHandlers = {
      ...cb,
      onDone: (msg: unknown) => resolve({ appModel, skippedLines: (msg as { skippedLines?: number })?.skippedLines ?? 0 }),
      onError: (msg: unknown) => reject(onDecodeError(msg)),
    };
    const emit = (msg: unknown) => dispatch(msg, handlers);
    const state = createState();
    run(state, emit, reject);
  });
}

export async function collectRun(inputPath: string): Promise<{ appModel: AppModel; skippedLines: number }> {
  const stat = statSync(inputPath);
  return collectViaDispatch((state, emit, reject) => {
    if (stat.isDirectory()) {
      if (!isRollingLogDirectory(inputPath)) {
        reject(new Error("This isn't a Spark rolling event-log directory. Pass a single event-log file instead."));
        return;
      }
      const names = readdirSync(inputPath);
      let ordered;
      try {
        ordered = reassembleRollingEntries(names);
      } catch (e) {
        reject(e);
        return;
      }
      const files = ordered.map((name) => nodeFileFromPath(join(inputPath, name)));
      // .catch(reject), not void: a throw past the parser's guards would otherwise leave
      // this Promise pending forever, surfacing only as an unhandled rejection.
      runParseFiles(files, state, { emit, ...nodeParseCodecs }).catch(reject);
    } else {
      runParse(nodeFileFromPath(inputPath), state, { emit, ...nodeParseCodecs }).catch(reject);
    }
  }, (msg) => new Error((msg as { message: string }).message));
}
