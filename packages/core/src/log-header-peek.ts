import { streamFile } from './parser-worker.ts';
import { buildChunkDecoder } from './event-handlers.ts';

type PeekableFile = {
  name: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

export interface LogHeaderPeek {
  appId: string | null;
  name: string | null;
  sparkVersion: string | null;
  startTimeMs: number | null;
}

// list_runs peeks every candidate file in a shared directory: bound the work per file so one
// huge or malformed log can't blow out a directory scan. 50 lines is comfortably past where
// LogStart/ApplicationStart appear in a real log (they're always among the first few events).
const MAX_PEEK_LINES = 50;
// Small on purpose: unlike the full parse path (CHUNK_SIZE = 512KB, tuned for progress-bar
// granularity on multi-GB files), a peek wants the *first* read to already be enough: reading in
// 64KB steps means the 50-line cap trips after very little decompression work, not after one
// giant chunk decodes thousands of lines at once.
const PEEK_CHUNK_BYTES = 64 * 1024;

// Thrown from inside the streamFile->decoder->onChunk callback chain to unwind out of the
// (possibly still-looping) decompression stream the instant enough header lines are seen: the
// rest of the file is never requested from `file.slice()` after this.
class PeekComplete extends Error {}

export async function peekLogHeader(file: PeekableFile): Promise<LogHeaderPeek | null> {
  if (file.size === 0) return null;

  const decoder = buildChunkDecoder();
  let linesRead = 0;
  let sawLogStart = false;
  let sawAppStart = false;
  const result: LogHeaderPeek = { appId: null, name: null, sparkVersion: null, startTimeMs: null };

  const processLine = (line: string) => {
    linesRead++;
    let event: Record<string, unknown> | null = null;
    try {
      event = JSON.parse(line);
    } catch {
      // Corrupt/partial line: same silent-skip as dispatchLine's state.skippedLines++ path.
    }
    if (event) {
      if (event.Event === 'SparkListenerLogStart') {
        if (typeof event['Spark Version'] === 'string') result.sparkVersion = event['Spark Version'];
        sawLogStart = true;
      } else if (event.Event === 'SparkListenerApplicationStart') {
        if (typeof event['App ID'] === 'string') result.appId = event['App ID'];
        if (typeof event['App Name'] === 'string') result.name = event['App Name'];
        if (typeof event['Timestamp'] === 'number') result.startTimeMs = event['Timestamp'];
        // ApplicationStart's own Spark Version is only a fallback: a preceding LogStart always
        // wins, mirroring event-handlers.ts's startApplication precedence
        // (state.pendingSparkVersion ?? event['Spark Version']).
        if (!sawLogStart && typeof event['Spark Version'] === 'string') result.sparkVersion = event['Spark Version'];
        sawAppStart = true;
      }
    }
    if ((sawLogStart && sawAppStart) || linesRead >= MAX_PEEK_LINES) throw new PeekComplete();
  };

  const feed = (bytes: Uint8Array) => {
    for (const line of decoder.decode(bytes)) processLine(line);
  };

  try {
    await streamFile(file, feed, PEEK_CHUNK_BYTES);
    // A trailing header line with no terminating newline sits in the decoder's pending buffer
    // until flushed, same as parser-worker.ts's runParse/runParseFiles do after their streamFile call.
    for (const line of decoder.flush()) processLine(line);
  } catch (e) {
    if (!(e instanceof PeekComplete)) return null; // unsupported/corrupt codec: same silent-skip as any unpeekable candidate
  }

  return sawAppStart ? result : null;
}
