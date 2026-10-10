import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A worker that dies the way a thread out of memory does, or that never starts.
const behavior = { event: 'error' };
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super();
      setImmediate(() => this.emit(behavior.event, new Error('Worker terminated due to reaching memory limit')));
    }

    terminate() { return Promise.resolve(0); }
  },
}));

const { collectRun } = await import('../src/cli/collect-run.js');
const { collectRunInWorker, collectRunPair } = await import('../src/cli/collect-run-pair.js');

const AQE_SKEW = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aqe-skew-spark-3.5.ndjson');

describe('collectRunInWorker when the worker thread fails', () => {
  it.each(['error', 'exit'])('parses the log in this thread after a worker %s', async (event) => {
    behavior.event = event;
    expect(await collectRunInWorker(AQE_SKEW)).toEqual(await collectRun(AQE_SKEW));
  });

  it('still returns both runs of a pair', async () => {
    behavior.event = 'error';
    const { baseline, candidate } = await collectRunPair(AQE_SKEW, AQE_SKEW, { minOffloadBytes: 0 });
    const own = await collectRun(AQE_SKEW);
    expect(baseline.value).toEqual(own);
    expect(candidate.value).toEqual(own);
  });
});
