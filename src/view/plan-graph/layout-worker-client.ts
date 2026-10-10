import type { LayoutJob, LayoutPositions } from './dagre-layout';
import type { LayoutWorkerReply, LayoutWorkerRequest } from './layout.worker';

// Below this many nodes a Dagre pass costs about as much as the worker round trip
// (roughly 1ms per node), so small graphs stay on the main thread.
export const WORKER_LAYOUT_MIN_NODES = 200;

type Pending = { resolve: (positions: LayoutPositions | null) => void };

// The `new Worker(new URL(...), ...)` expression must stay inline for Vite's worker plugin.
const spawnLayoutWorker = (): Worker => new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
let createWorker = spawnLayoutWorker;

/** Test hook: replaces how the worker is created (import.meta.url is not a URL under vitest). */
export function overrideLayoutWorkerFactory(factory: () => Worker): void {
  createWorker = factory;
}

let worker: Worker | null = null;
let workerFailed = false;
const workersAvailable = () => !workerFailed && typeof Worker !== 'undefined';
let nextRequestId = 1;
const pending = new Map<number, Pending>();

/** True when a layout of this size should go to the worker. False once the worker
 * has failed to start or died, and wherever Web Workers do not exist. */
export function shouldLayoutInWorker(nodeCount: number): boolean {
  return workersAvailable() && nodeCount >= WORKER_LAYOUT_MIN_NODES;
}

function failWorker(): void {
  workerFailed = true;
  worker?.terminate();
  worker = null;
  // Waiting callers get null and fall back to the main-thread layout.
  for (const { resolve } of pending.values()) resolve(null);
  pending.clear();
}

function startWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = createWorker();
  } catch {
    failWorker();
    return null;
  }
  worker.onmessage = (event: MessageEvent<LayoutWorkerReply>) => {
    const reply = event.data;
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    // A layout error (for instance Dagre's intersection failure) is not a worker
    // failure: resolve null so the main-thread pass throws it where it always did.
    entry.resolve('positions' in reply ? new Map(reply.positions.map(([id, x, y]) => [id, { x, y }])) : null);
  };
  worker.onerror = failWorker;
  worker.onmessageerror = failWorker;
  return worker;
}

/** Starts the worker ahead of the first layout request, so a large plan that is
 * about to be laid out does not also wait for the worker script to load. */
export function warmLayoutWorker(): void {
  if (workersAvailable()) startWorker();
}

/** Lays the job out in the worker. Resolves null when the worker cannot start,
 * dies, or the layout throws; the caller then lays it out on the main thread. */
export function layoutInWorker(job: LayoutJob): Promise<LayoutPositions | null> {
  const active = startWorker();
  if (!active) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, { resolve });
    active.postMessage({ id, job } satisfies LayoutWorkerRequest);
  });
}
