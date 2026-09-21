// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider } from '@/view/DocsContext';
import { clearPlanGraphModelCache, collapseHiddenEdges, PlanGraphRoute } from '@/view/PlanGraphRoute';
import { emptyAppModel } from '@/store/store';
import type { ReactElement } from 'react';
import type { PlanGraphModel } from '@sparkforensics/core/types.ts';

function renderRoute(ui: ReactElement) {
  return render(
    <ThemeProvider>
      <DocsProvider>{ui}</DocsProvider>
    </ThemeProvider>,
  );
}

// React Flow renders no edge <path> in jsdom (no layout/measure), so
// connectivity can't be read from the DOM. Stubbing PlanGraphCanvas lets this
// test inspect the actual `model.edges` PlanGraphRoute computes, which the bug broke.
let lastCanvasModel: PlanGraphModel | null = null;
let lastVisibleNodeIds: Set<string> | undefined;
let lastVisibleEdges: PlanGraphModel['edges'] | undefined;
vi.mock('@/view/plan-graph/PlanGraphCanvas', () => ({
  PlanGraphCanvas: ({ model, visibleNodeIds, visibleEdges }: {
    model: PlanGraphModel;
    visibleNodeIds?: Set<string>;
    visibleEdges?: PlanGraphModel['edges'];
  }) => {
    lastCanvasModel = model;
    lastVisibleNodeIds = visibleNodeIds;
    lastVisibleEdges = visibleEdges;
    return (
      <div data-testid="plan-graph-canvas-stub">
        {model.nodes.filter((n) => !visibleNodeIds || visibleNodeIds.has(n.id)).map((n) => <span key={n.id}>{n.label}</span>)}
      </div>
    );
  },
}));

function planTreeAppModel(stageId: number, planTree: unknown) {
  const appModel = emptyAppModel();
  appModel.stages.set(stageId, { id: stageId, sqlExecutionId: 1 } as never);
  appModel.sql.set(1, { executionId: 1, planTree, stageIds: [stageId] } as never);
  return appModel;
}

test('Basic filter mode reconnects visible nodes across a hidden pass-through node instead of leaving them disconnected', () => {
  // SortMergeJoin (join, visible) -> Project (transform, hidden under Basic)
  // -> Scan parquet (scan, visible): the shape that fragments into two
  // disconnected nodes if Project's edges are dropped without reconnecting.
  const planTree = {
    id: 'n0', name: 'SortMergeJoin', detail: 'SortMergeJoin', metrics: [],
    children: [{
      id: 'n1', name: 'Project', detail: 'Project', metrics: [],
      children: [{ id: 'n2', name: 'Scan parquet', detail: 'Scan parquet', metrics: [], children: [] }],
    }],
  };
  const appModel = planTreeAppModel(7, planTree);

  renderRoute(
    <PlanGraphRoute stageId={7} appModel={appModel} findings={[]} activeFileId="file-1" onClose={() => {}} />,
  );

  expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
  expect(screen.getByText('Scan parquet')).toBeInTheDocument();
  expect(screen.queryByText('Project')).not.toBeInTheDocument();

  expect(lastCanvasModel).not.toBeNull();
  expect(lastCanvasModel!.nodes.map((n) => n.label).sort()).toEqual(['Project', 'Scan parquet', 'SortMergeJoin']);
  expect(lastVisibleEdges).toHaveLength(1);
  const [edge] = lastVisibleEdges!;
  const nodesById = new Map(lastCanvasModel!.nodes.map((n) => [n.id, n.label]));
  expect([nodesById.get(edge.source), nodesById.get(edge.target)]).toEqual(['SortMergeJoin', 'Scan parquet']);
});

test('collapseHiddenEdges keeps the shuffle weight on a direct visible edge but not on one rewired across a hidden node', () => {
  const edges = [
    { id: 'a->b', source: 'a', target: 'b', shuffleBytes: 4096 }, // direct exchange, both endpoints visible
    { id: 'b->h', source: 'b', target: 'h' },
    { id: 'h->c', source: 'h', target: 'c', shuffleBytes: 8192 }, // hidden -> visible; the rewired b=>c must not inherit this
  ];
  const collapsed = collapseHiddenEdges(edges, new Set(['a', 'b', 'c']));

  const direct = collapsed.find((e) => e.source === 'a' && e.target === 'b');
  const rewired = collapsed.find((e) => e.source === 'b' && e.target === 'c');
  expect(direct?.shuffleBytes).toBe(4096);
  expect(rewired).toBeTruthy();
  expect(rewired?.shuffleBytes).toBeUndefined();
});

test('Basic filtering preserves the full model for canvas grouping while separately identifying foreground nodes', () => {
  clearPlanGraphModelCache();
  const planTree = {
    id: 'n0', name: 'Project', detail: 'Project', metrics: [], children: [],
  };
  const appModel = planTreeAppModel(7, planTree);

  renderRoute(
    <PlanGraphRoute stageId={7} appModel={appModel} findings={[]} activeFileId="file-1" onClose={() => {}} />,
  );

  expect(lastCanvasModel).not.toBeNull();
  expect(lastCanvasModel!.nodes.map((n) => n.label)).toEqual(['Project']);
  expect(lastVisibleNodeIds).toEqual(new Set());
  expect(screen.queryByText('Project')).not.toBeInTheDocument();
});
