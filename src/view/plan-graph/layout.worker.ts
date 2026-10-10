import { runDagre, type LayoutJob } from './dagre-layout';

// Runs the Dagre pass for a plan graph off the main thread. A request carries the
// plain-data job `pendingLayoutJob` built; the reply is the positions in node order.
export type LayoutWorkerRequest = { id: number; job: LayoutJob };
export type LayoutWorkerReply =
  | { id: number; positions: [string, number, number][] }
  | { id: number; error: string };

self.onmessage = (event: MessageEvent<LayoutWorkerRequest>) => {
  const { id, job } = event.data;
  try {
    const positions = [...runDagre(job)].map(([nodeId, pos]): [string, number, number] => [nodeId, pos.x, pos.y]);
    self.postMessage({ id, positions } satisfies LayoutWorkerReply);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies LayoutWorkerReply);
  }
};
