import { useEffect, useMemo, useState } from 'react';
import type { PlanGraphEdge, PlanGraphNodeData } from '@sparkforensics/core/types.ts';
import { pendingLayoutJob, storeLayout, type PlanLayoutDirection } from './dagre-layout';
import { layoutInWorker, shouldLayoutInWorker } from './layout-worker-client';

export interface LayoutRequest {
  nodes: PlanGraphNodeData[];
  edges: PlanGraphEdge[];
  groupOf: (node: PlanGraphNodeData) => string | null;
  direction: PlanLayoutDirection;
}

/**
 * Runs the large, not yet cached layouts in a Web Worker and stores them in the
 * layout cache, so the synchronous `layoutWithDagre` calls that follow are cache
 * hits. Returns false while a worker layout is in flight; true when there is
 * nothing to wait for (everything cached, small, or no worker available), in
 * which case the caller lays out on the main thread exactly as before.
 */
export function useLayoutPrewarm(requests: LayoutRequest[]): boolean {
  const jobs = useMemo(
    () => {
      const unique = new Map<string, NonNullable<ReturnType<typeof pendingLayoutJob>>>();
      for (const { nodes, edges, groupOf, direction } of requests) {
        if (!shouldLayoutInWorker(nodes.length)) continue;
        const job = pendingLayoutJob(nodes, edges, { groupOf, direction });
        if (job) unique.set(job.key, job);
      }
      return [...unique.values()];
    },
    [requests],
  );
  // Settled batches are remembered by identity, so a batch that finished stays ready.
  const [settled, setSettled] = useState<unknown>(null);

  useEffect(() => {
    if (jobs.length === 0) return;
    let live = true;
    void Promise.all(
      jobs.map(async (job) => {
        const positions = await layoutInWorker(job);
        if (positions) storeLayout(job.key, positions);
      }),
    ).then(() => {
      if (live) setSettled(jobs);
    });
    return () => {
      live = false;
    };
  }, [jobs]);

  return jobs.length === 0 || settled === jobs;
}
