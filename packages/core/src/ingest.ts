// Worker/CLI-shared message router: maps a parser message to its handler. Exported so both contexts
// run one switch. `pendingTaskRequests` is optional: the CLI path never sends a `getTaskData`
// request, so never receives `taskData` back. Handlers are optional, so a consumer wires only the
// messages it reads; the switch is exhaustive, so a new message type must be routed here.
import type { ParserMessage } from './parser-messages.ts';

type RoutedMessage = Exclude<ParserMessage, { type: 'taskData' }>;
// A message with a `data` field hands its handler that payload; progress and error have none and
// hand the handler the whole message.
type HandlerPayload<M> = M extends { data: infer D } ? D : M;

/** One optional handler per routed message type, named `on` plus the capitalized type. */
export type IngestHandlers = {
  [M in RoutedMessage as `on${Capitalize<M['type']>}`]?: (payload: HandlerPayload<M>) => void;
};

interface PendingTaskRequest {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

function assertNever(message: never): never {
  throw new Error(`Unrouted parser message: ${JSON.stringify(message)}`);
}

export function routeMessage(
  msg: ParserMessage,
  handlers: IngestHandlers,
  pendingTaskRequests?: Map<string | number, PendingTaskRequest>
): void {
  switch (msg.type) {
    case 'progress': handlers.onProgress?.(msg); break;
    case 'app':      handlers.onApp?.(msg.data); break;
    case 'stage':    handlers.onStage?.(msg.data); break;
    case 'sql':      handlers.onSql?.(msg.data); break;
    case 'sqlPlan':  handlers.onSqlPlan?.(msg.data); break;
    case 'executor': handlers.onExecutor?.(msg.data); break;
    case 'job':      handlers.onJob?.(msg.data); break;
    case 'runAggregates': handlers.onRunAggregates?.(msg.data); break;
    case 'stageExecutorMetrics': handlers.onStageExecutorMetrics?.(msg.data); break;
    case 'stageSpeculationWaste': handlers.onStageSpeculationWaste?.(msg.data); break;
    case 'stageLateAttemptWork': handlers.onStageLateAttemptWork?.(msg.data); break;
    case 'done':     handlers.onDone?.(msg.data); break;
    case 'error':    handlers.onError?.(msg); break;
    case 'taskData': {
      const pending = pendingTaskRequests?.get(msg.reqId);
      if (pending) {
        pending.resolve({ metrics: msg.metrics, fieldNames: msg.fieldNames });
        pendingTaskRequests!.delete(msg.reqId);
      }
      break;
    }
    default: assertNever(msg);
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
      handlers.onError?.({ type: 'error', message: `Worker crashed: ${err.message}` });
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
