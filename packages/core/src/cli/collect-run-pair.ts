import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { collectRun } from './collect-run.ts';
import { mcpError } from '../mcp-error.ts';

type CollectedRun = Awaited<ReturnType<typeof collectRun>>;

// Parsing is single-threaded JS, so two logs parsed one after the other take the sum of their
// times, and parsing both on one thread (interleaved) takes the same. A worker thread parses one of
// them in parallel at the price of a thread start (about 50 ms) and a structured clone of the model
// (about 100 ms for the model of a 140 MB zstd log), so it pays only when the log it parses is big enough.
const COMPRESSED_LOG = /\.(zstd?|lz4|snappy|zip|gz)$/i;
// A compressed log holds about this many times its size in event text, and parses at about that
// many times the cost per byte on disk (measured: 7 to 12 on real zstd logs).
const COMPRESSED_EXPANSION = 8;
/** The smaller log's estimated event text (bytes) below which both logs parse in this thread. */
export const MIN_OFFLOAD_PARSE_BYTES = 32 * 1024 * 1024;

/** Event-text bytes a log is expected to parse, from its size on disk. 0 when it cannot be read:
 * `collectRun` reports that failure itself. */
export function estimatedParseBytes(path: string): number {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return readdirSync(path).reduce((sum, name) => sum + estimatedParseBytes(join(path, name)), 0);
    return COMPRESSED_LOG.test(path) ? stat.size * COMPRESSED_EXPANSION : stat.size;
  } catch {
    return 0;
  }
}

/** `collectRun` on a worker thread. A worker that cannot start, dies (out of memory included) or
 * returns a model it cannot clone falls back to parsing in this thread; a log the parser rejects
 * rejects here with the same message and code. */
export function collectRunInWorker(path: string): Promise<CollectedRun> {
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(new URL('./collect-run-worker.js', import.meta.url), { workerData: { path } });
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      void worker.terminate();
      settle();
    };
    const parseHere = (): void => finish(() => { collectRun(path).then(resolve, reject); });
    worker.once('message', (msg: { run?: CollectedRun; failed?: { message: string; code?: string } }) => {
      if (msg.run) finish(() => resolve(msg.run!));
      else finish(() => reject(mcpError(msg.failed?.code ?? 'invalid-event-log', msg.failed?.message ?? 'The event log could not be parsed.')));
    });
    worker.once('error', parseHere);
    worker.once('exit', parseHere);
  });
}

export interface CollectedPair {
  baseline: PromiseSettledResult<CollectedRun>;
  /** Absent when the baseline failed before the candidate was started. */
  candidate?: PromiseSettledResult<CollectedRun>;
}

const settle = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));

/** Collects a baseline and a candidate run. When even the smaller log is big enough to repay a
 * thread, it parses in a worker while this thread parses the other, so the pair takes about as long
 * as the bigger log alone; otherwise the two parse here, baseline first, and a baseline that fails
 * stops the candidate from being read. The model is the same either way. */
export async function collectRunPair(
  baselinePath: string, candidatePath: string, { minOffloadBytes = MIN_OFFLOAD_PARSE_BYTES } = {},
): Promise<CollectedPair> {
  const baselineBytes = estimatedParseBytes(baselinePath), candidateBytes = estimatedParseBytes(candidatePath);
  if (Math.min(baselineBytes, candidateBytes) < minOffloadBytes) {
    const baseline = await settle(collectRun(baselinePath));
    return baseline.status === 'rejected' ? { baseline } : { baseline, candidate: await settle(collectRun(candidatePath)) };
  }
  const offloadBaseline = baselineBytes <= candidateBytes;
  const [baseline, candidate] = await Promise.all([
    settle(offloadBaseline ? collectRunInWorker(baselinePath) : collectRun(baselinePath)),
    settle(offloadBaseline ? collectRun(candidatePath) : collectRunInWorker(candidatePath)),
  ]);
  return { baseline, candidate };
}
