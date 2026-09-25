import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createState, runParse, runParseFiles, reassembleRollingEntries } from '../parser-worker.ts';
import { nodeParseCodecs } from './native-zstd.ts';
import { createModelCallbacks } from '../model-assembler.ts';
import { routeMessage, type IngestHandlers } from '../ingest.ts';
import type { AppModel } from '../types.ts';

// No whole-file arrayBuffer(): the parser only ever reads bounded slices, and a
// whole-file read is what capped local logs at 2 GiB.
export interface FileLike {
  name: string; size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  /** Releases the file descriptor, if one is open. Safe to call more than once. */
  close(): void;
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

// File-like shape runParse/runParseFiles need (name, size, slice().arrayBuffer()), read with
// positioned readSync so only the requested slice is ever in memory, whatever the file size.
// The descriptor opens on the first read and closes once a read reaches the end of the file,
// so a rolling directory's parts hold at most one open descriptor at a time while streaming.
// A later read (a zip archive reads its tail first) reopens it; callers must still call
// close() once parsing settles, to cover reads that stopped early on an error.
export function nodeFileFromPath(path: string): FileLike {
  const name = basename(path);
  const size = statSync(path).size;
  let fd: number | null = null;
  const close = () => {
    if (fd === null) return;
    const open = fd;
    fd = null;
    closeSync(open);
  };
  return {
    name,
    size,
    slice(start: number, end: number) {
      return {
        async arrayBuffer(): Promise<ArrayBuffer> {
          const from = Math.max(0, start);
          const to = Math.min(end, size);
          if (to <= from) return new ArrayBuffer(0);
          const buf = new Uint8Array(to - from);
          fd ??= openSync(path, 'r');
          // readSync may return fewer bytes than asked; loop until the slice is full.
          for (let filled = 0; filled < buf.length;) {
            const n = readSync(fd, buf, filled, buf.length - filled, from + filled);
            if (n === 0) {
              close();
              throw new Error(`"${name}" shrank while it was being read`);
            }
            filled += n;
          }
          if (to === size) close();
          return buf.buffer;
        },
      };
    },
    close,
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
  // Every file opened for this run, closed once parsing settles on any path (done, parse
  // error, decode error, or a throw past the parser's guards).
  const opened: FileLike[] = [];
  const open = (path: string) => {
    const file = nodeFileFromPath(path);
    opened.push(file);
    return file;
  };
  try {
    return await collectViaDispatch((state, emit, reject) => {
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
        const files = ordered.map((name) => open(join(inputPath, name)));
        // .catch(reject), not void: a throw past the parser's guards would otherwise leave
        // this Promise pending forever, surfacing only as an unhandled rejection.
        runParseFiles(files, state, { emit, ...nodeParseCodecs }).catch(reject);
      } else {
        runParse(open(inputPath), state, { emit, ...nodeParseCodecs }).catch(reject);
      }
    }, (msg) => new Error((msg as { message: string }).message));
  } finally {
    for (const file of opened) file.close();
  }
}
