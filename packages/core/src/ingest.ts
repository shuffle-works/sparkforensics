// Worker/CLI-shared message router: maps a worker (or Node-synchronous) message to its handler.
// Exported so both contexts run one switch. `pendingTaskRequests` is optional: the CLI path never
// sends a `getTaskData` request, so never receives `taskData` back. Handler dispatch is
// optional-chained, so a caller that adds a message type without wiring its handler no-ops rather than throws.

export interface IngestHandlers {
  onProgress?: (data: unknown) => void;
  onApp?: (data: unknown) => void;
  onStage?: (data: unknown) => void;
  onSql?: (data: unknown) => void;
  onSqlPlan?: (data: unknown) => void;
  onExecutor?: (data: unknown) => void;
  onJob?: (data: unknown) => void;
  onRunAggregates?: (data: unknown) => void;
  onStageExecutorMetrics?: (data: unknown) => void;
  onStageSpeculationWaste?: (data: unknown) => void;
  onDone?: (data: unknown) => void;
  onError?: (data: unknown) => void;
}

interface PendingTaskRequest {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export function routeMessage(
  data: { type: string; [k: string]: unknown },
  handlers: IngestHandlers,
  pendingTaskRequests?: Map<string | number, PendingTaskRequest>
): void {
  switch (data.type) {
    case 'progress': handlers.onProgress?.(data); break;
    case 'app':      handlers.onApp?.(data.data); break;
    case 'stage':    handlers.onStage?.(data.data); break;
    case 'sql':      handlers.onSql?.(data.data); break;
    case 'sqlPlan':  handlers.onSqlPlan?.(data.data); break;
    case 'executor': handlers.onExecutor?.(data.data); break;
    case 'job':      handlers.onJob?.(data.data); break;
    case 'runAggregates': handlers.onRunAggregates?.(data.data); break;
    case 'stageExecutorMetrics': handlers.onStageExecutorMetrics?.(data.data); break;
    case 'stageSpeculationWaste': handlers.onStageSpeculationWaste?.(data.data); break;
    case 'done': {
      const { skippedLines } = data;
      handlers.onDone?.({ skippedLines });
      break;
    }
    case 'error':    handlers.onError?.(data); break;
    case 'taskData': {
      const pending = pendingTaskRequests?.get(data.reqId as string | number);
      if (pending) {
        pending.resolve({ metrics: data.metrics, fieldNames: data.fieldNames });
        pendingTaskRequests!.delete(data.reqId as string | number);
      }
      break;
    }
  }
}

interface IngestTaskData {
  metrics: Float64Array | number[];
  fieldNames: string[];
}

export function createIngestClient(): {
  startParse: (file: File, h: IngestHandlers) => void;
  startParseFromUrl: (request: unknown, h: IngestHandlers) => void;
  startParseFiles: (files: unknown, h: IngestHandlers) => void;
  requestTaskData: (stageId: number) => Promise<IngestTaskData>;
  prefetchFlaggedStages: (flaggedStageIds: number[]) => Promise<Array<IngestTaskData & { stageId: number }>>;
  terminate: () => void;
} {
  let worker: Worker | null = null;
  const pendingTaskRequests = new Map<string | number, PendingTaskRequest>();
  let reqCounter = 0;

  let handlers: IngestHandlers = {};

  // The `new Worker(new URL(...), ...)` expression must appear inline for Vite's worker plugin to
  // statically detect and bundle it (with its own imports); routing the URL through a variable
  // defeats detection and leaves the worker's deps unbundled, 404ing in a production build.
  function makeWorker() {
    worker = new Worker(new URL('./parser-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => routeMessage(data, handlers, pendingTaskRequests);
    worker.onerror = (err) => {
      handlers.onError?.(`Worker crashed: ${err.message}`);
      terminate();
    };
  }

  function startParse(file: File, h: IngestHandlers) {
    handlers = h;
    makeWorker();
    worker!.postMessage({ type: 'parse', file });
  }

  function startParseFromUrl(request: unknown, h: IngestHandlers) {
    handlers = h;
    makeWorker();
    worker!.postMessage({ type: 'parseFromUrl', request });
  }

  function startParseFiles(files: unknown, h: IngestHandlers) {
    handlers = h;
    makeWorker();
    worker!.postMessage({ type: 'parseFiles', files });
  }

  function requestTaskData(stageId: number): Promise<IngestTaskData> {
    return new Promise<unknown>((resolve, reject) => {
      const reqId = String(reqCounter++);
      pendingTaskRequests.set(reqId, { resolve, reject });
      worker!.postMessage({ type: 'getTaskData', stageId, reqId });
    }) as Promise<IngestTaskData>;
  }

  async function prefetchFlaggedStages(flaggedStageIds: number[]): Promise<Array<IngestTaskData & { stageId: number }>> {
    const results = await Promise.all(
      flaggedStageIds.map(stageId =>
        requestTaskData(stageId).then(data => ({ stageId, ...data }))
      )
    );
    return results;
  }

  function terminate() {
    worker?.terminate();
    worker = null;
    for (const { reject } of pendingTaskRequests.values()) {
      reject(new Error('Worker terminated'));
    }
    pendingTaskRequests.clear();
  }

  return { startParse, startParseFromUrl, startParseFiles, requestTaskData, prefetchFlaggedStages, terminate };
}
