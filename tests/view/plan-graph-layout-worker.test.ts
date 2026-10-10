// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { PlanGraphEdge, PlanGraphNodeData } from '@sparkforensics/core/types.ts';

function graphNode(id: string, segmentIndex: number): PlanGraphNodeData {
  return {
    id, sourceNodeId: id, label: id, category: 'transform', operatorDetail: '', primaryMetric: '',
    segmentIndex, splitRole: null, durationShare: null,
  };
}

// A chain split into segments of ten, so the layout is compound like the canvas's.
function chain(count: number) {
  const nodes = Array.from({ length: count }, (_, i) => graphNode(`n${i}`, Math.floor(i / 10)));
  const edges: PlanGraphEdge[] = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id }));
  return { nodes, edges };
}
const groupOf = (n: PlanGraphNodeData) => `segment-${n.segmentIndex}`;

// Stands in for the layout worker: the real worker module handles each request in
// this thread, with the structured-clone hop a worker message makes.
function installFakeWorker(mode: 'works' | 'throws-on-start' | 'errors-on-run') {
  const workerSelf: { onmessage?: (e: { data: unknown }) => void; postMessage: (m: unknown) => void } = {
    postMessage: () => {},
  };
  const created: unknown[] = [];
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor() {
      if (mode === 'throws-on-start') throw new Error('no workers here');
      created.push(this);
      workerSelf.postMessage = (message) => queueMicrotask(() => this.onmessage?.({ data: structuredClone(message) }));
    }
    postMessage(message: unknown) {
      queueMicrotask(() => {
        if (mode === 'errors-on-run') this.onerror?.();
        else workerSelf.onmessage?.({ data: structuredClone(message) });
      });
    }
    terminate() {}
  }
  vi.stubGlobal('self', workerSelf);
  vi.stubGlobal('Worker', FakeWorker);
  return { created, FakeWorker };
}

async function loadModules({ withWorker = true, workerClass }: { withWorker?: boolean; workerClass?: new () => unknown } = {}) {
  vi.resetModules();
  const layout = await import('../../src/view/plan-graph/dagre-layout');
  const client = await import('../../src/view/plan-graph/layout-worker-client');
  const { useLayoutPrewarm } = await import('../../src/view/plan-graph/useLayoutPrewarm');
  if (workerClass) client.overrideLayoutWorkerFactory(() => new workerClass() as unknown as Worker);
  if (withWorker) await import('../../src/view/plan-graph/layout.worker');
  return { layout, client, useLayoutPrewarm };
}

describe('layout worker', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('stores the positions the main thread would compute, so the layout is a cache hit', async () => {
    const { FakeWorker } = installFakeWorker('works');
    const { layout, client, useLayoutPrewarm } = await loadModules({ workerClass: FakeWorker });
    const { nodes, edges } = chain(client.WORKER_LAYOUT_MIN_NODES + 20);
    const expected = layout.layoutWithDagre(nodes, edges, { groupOf });
    layout.clearLayoutCache();

    const requests = [{ nodes, edges, groupOf, direction: 'RL' as const }];
    const { result } = renderHook(() => useLayoutPrewarm(requests));
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));

    // Cached: nothing left for a worker to compute, and the positions are identical.
    expect(layout.pendingLayoutJob(nodes, edges, { groupOf })).toBeNull();
    expect(layout.layoutWithDagre(nodes, edges, { groupOf })).toEqual(expected);
  });

  it('keeps small graphs on the main thread', async () => {
    const { created, FakeWorker } = installFakeWorker('works');
    const { client, useLayoutPrewarm } = await loadModules({ workerClass: FakeWorker });
    const { nodes, edges } = chain(client.WORKER_LAYOUT_MIN_NODES - 1);
    const { result } = renderHook(() => useLayoutPrewarm([{ nodes, edges, groupOf, direction: 'RL' }]));
    expect(result.current).toBe(true);
    expect(created).toHaveLength(0);
  });

  it('falls back to the main thread when the worker cannot start', async () => {
    const { FakeWorker } = installFakeWorker('throws-on-start');
    const { layout, client, useLayoutPrewarm } = await loadModules({ workerClass: FakeWorker });
    const { nodes, edges } = chain(client.WORKER_LAYOUT_MIN_NODES);
    const { result } = renderHook(() => useLayoutPrewarm([{ nodes, edges, groupOf, direction: 'RL' }]));
    await waitFor(() => expect(result.current).toBe(true));
    expect(client.shouldLayoutInWorker(client.WORKER_LAYOUT_MIN_NODES)).toBe(false);
    expect(layout.layoutWithDagre(nodes, edges, { groupOf })).toHaveLength(nodes.length);
  });

  it('falls back to the main thread when the worker dies mid-layout', async () => {
    const { FakeWorker } = installFakeWorker('errors-on-run');
    const { layout, client, useLayoutPrewarm } = await loadModules({ workerClass: FakeWorker });
    const { nodes, edges } = chain(client.WORKER_LAYOUT_MIN_NODES);
    const { result } = renderHook(() => useLayoutPrewarm([{ nodes, edges, groupOf, direction: 'RL' }]));
    await waitFor(() => expect(result.current).toBe(true));
    expect(client.shouldLayoutInWorker(client.WORKER_LAYOUT_MIN_NODES)).toBe(false);
    expect(layout.pendingLayoutJob(nodes, edges, { groupOf })).not.toBeNull();
    expect(layout.layoutWithDagre(nodes, edges, { groupOf })).toHaveLength(nodes.length);
  });

  it('never starts a worker where Web Workers do not exist', async () => {
    vi.stubGlobal('Worker', undefined);
    const { client } = await loadModules({ withWorker: false });
    expect(client.shouldLayoutInWorker(10_000)).toBe(false);
  });
});
