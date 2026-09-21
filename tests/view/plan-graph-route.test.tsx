// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider } from '@/view/DocsContext';
import { PlanGraphRoute } from '@/view/PlanGraphRoute';
import { emptyAppModel } from '@/store/store';
import type { ReactElement } from 'react';
import type { AppModel } from '@sparkforensics/core/types.ts';

// Count every Dagre layout pass (the expensive main-thread work) so a
// regression test can assert that merely opening a node detail card does not
// re-run it. The spy delegates to the real implementation so layout behavior is
// unchanged; only the call count is observed.
const layoutSpy = vi.hoisted(() => vi.fn());
vi.mock('@/view/plan-graph/dagre-layout', async () => {
  const actual = await vi.importActual<typeof import('@/view/plan-graph/dagre-layout')>(
    '@/view/plan-graph/dagre-layout',
  );
  return {
    ...actual,
    layoutWithDagre: (...args: Parameters<typeof actual.layoutWithDagre>) => {
      layoutSpy();
      return actual.layoutWithDagre(...args);
    },
  };
});

// Real ReactFlow still renders (…actual), but ViewportAutoFit's programmatic
// viewport calls are captured so a test can assert a scope switch re-fits.
const fitViewMock = vi.hoisted(() => vi.fn());
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    useReactFlow: () => ({
      fitView: fitViewMock,
      setCenter: vi.fn(),
      getNode: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
    }),
  };
});

function renderRoute(ui: ReactElement) {
  return render(
    <ThemeProvider>
      <DocsProvider>{ui}</DocsProvider>
    </ThemeProvider>,
  );
}

// PlanGraphRoute mounts PlanGraphCanvas (React Flow), which measures its
// container with a ResizeObserver on mount; jsdom has none. Same scoped stub
// as tests/view/app-plan-graph-route.test.tsx.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

function singleStageAppModel(stageId: number): AppModel {
  // Real trees carry a worker-assigned id on every node (resolvePlanTree in
  // event-handlers.ts); the plan graph keys nodes by it, so the fixture must
  // supply one too or nodes render with no id and can't be clicked.
  const planTree = { id: 'n0', name: 'SortMergeJoin', detail: 'SortMergeJoin', metrics: [], children: [] };
  const appModel = emptyAppModel();
  appModel.stages.set(stageId, { id: stageId, sqlExecutionId: 1 } as never);
  appModel.sql.set(1, { executionId: 1, planTree, stageIds: [stageId] } as never);
  return appModel;
}

test('defaults to the segment view when no initialScope is given', () => {
  renderRoute(
    <PlanGraphRoute stageId={7} appModel={singleStageAppModel(7)} findings={[]} activeFileId={null} onClose={vi.fn()} />,
  );
  expect(screen.getByRole('button', { name: /expand to full plan/i })).toBeInTheDocument();
});

test('always shows a Plan Advisor docs link, even with zero findings', () => {
  renderRoute(
    <PlanGraphRoute stageId={7} appModel={singleStageAppModel(7)} findings={[]} activeFileId={null} onClose={vi.fn()} />,
  );
  expect(screen.getByRole('link', { name: /plan advisor docs/i })).toBeInTheDocument();
});

test('clicking a plan node opens its detail card; Escape closes the card before the route', () => {
  const onClose = vi.fn();
  renderRoute(
    <PlanGraphRoute stageId={7} appModel={singleStageAppModel(7)} findings={[]} activeFileId={null} onClose={onClose} />,
  );
  // A plain click event avoids d3-drag's mousedown path (throws under jsdom).
  fireEvent.click(screen.getByText('SortMergeJoin'));
  expect(screen.getByTestId('plan-node-detail')).toBeInTheDocument();

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByTestId('plan-node-detail')).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('opening a node detail reuses the cached layout instead of re-running Dagre', () => {
  layoutSpy.mockClear();
  renderRoute(
    <PlanGraphRoute stageId={7} appModel={singleStageAppModel(7)} findings={[]} activeFileId={null} onClose={vi.fn()} />,
  );
  // The layout runs during the initial render(s); capture whatever that total
  // is, then assert selection adds nothing to it. Opening a detail card only
  // changes local selection state, so the graph geometry is unchanged and the
  // (expensive) layout must be served from the memo.
  const layoutCallsAfterMount = layoutSpy.mock.calls.length;
  expect(layoutCallsAfterMount).toBeGreaterThan(0);

  fireEvent.click(screen.getByText('SortMergeJoin'));
  expect(screen.getByTestId('plan-node-detail')).toBeInTheDocument();

  expect(layoutSpy.mock.calls.length).toBe(layoutCallsAfterMount);
});

test('initialScope="full" renders the full plan immediately, with no expand click needed', () => {
  renderRoute(
    <PlanGraphRoute
      stageId={7}
      appModel={singleStageAppModel(7)}
      findings={[]}
      activeFileId={null}
      onClose={vi.fn()}
      initialScope="full"
    />,
  );
  expect(screen.getByRole('button', { name: /back to segment view/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /expand to full plan/i })).not.toBeInTheDocument();
});

// A split Exchange across two stages: the write half + scan land in the
// producer segment (stage 1, earliest submittedAt), the read half + root in the
// consumer segment (stage 2). Mirrors resolvePlanTree's real split shape.
function splitExchangeAppModel(): AppModel {
  const scan = { id: 'n3', name: 'Scan parquet', detail: 'Scan parquet', metrics: [], children: [] };
  const write = { id: 'n2', name: 'Exchange', detail: '', metrics: [], children: [scan], exchangeRole: 'write' };
  const read = { id: 'n1', name: 'Exchange', detail: 'Exchange hashpartitioning', metrics: [], children: [write], exchangeRole: 'read' };
  const root = { id: 'n0', name: 'SortMergeJoin', detail: 'SortMergeJoin', metrics: [], children: [read] };
  const appModel = emptyAppModel();
  appModel.stages.set(1, { id: 1, sqlExecutionId: 1, submittedAt: 0, completedAt: 500 } as never);
  appModel.stages.set(2, { id: 2, sqlExecutionId: 1, submittedAt: 500, completedAt: 1000 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: root, stageIds: [1, 2] } as never);
  return appModel;
}

test('jumping to an Exchange partner in another segment expands to the full plan and selects it', () => {
  renderRoute(
    <PlanGraphRoute stageId={1} appModel={splitExchangeAppModel()} findings={[]} activeFileId={null} onClose={vi.fn()} />,
  );
  // Segment view of the producer stage: only the write half is on screen.
  expect(screen.getByRole('button', { name: /expand to full plan/i })).toBeInTheDocument();
  // getByTitle scopes to the node's label span (title={label}), not the
  // now-open-by-default legend's "Exchange" operator-key entry.
  fireEvent.click(screen.getByTitle('Exchange'));
  fireEvent.click(screen.getByRole('button', { name: /jump to read half/i }));

  // The partner read half lives in the consumer segment, so the jump expanded
  // to the full plan and selected it (its card now offers the reverse jump).
  expect(screen.getByRole('button', { name: /back to segment view/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /jump to write half/i })).toBeInTheDocument();

  // Jumping back: the write half is already on screen in the full plan, so this
  // selects it in place without leaving the full plan.
  fireEvent.click(screen.getByRole('button', { name: /jump to write half/i }));
  expect(screen.getByRole('button', { name: /back to segment view/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /jump to read half/i })).toBeInTheDocument();
});

test('jumping to another stage from the full plan re-fits the viewport', () => {
  renderRoute(
    <PlanGraphRoute
      stageId={1}
      appModel={splitExchangeAppModel()}
      findings={[]}
      activeFileId={null}
      onClose={vi.fn()}
      initialScope="full"
    />,
  );
  // Ignore any fit from the initial mount; only the scope switch is under test.
  fitViewMock.mockClear();

  // Clicking a stage box collapses the full plan to that stage's segment view.
  // The canvas stays mounted, so the mount-time fitView never re-fires; the
  // route must bump fitSignal to re-fit, or the user lands on a stale viewport.
  fireEvent.click(screen.getByRole('button', { name: /focus stage 2/i }));
  expect(screen.getByRole('button', { name: /expand to full plan/i })).toBeInTheDocument();
  expect(fitViewMock).toHaveBeenCalled();
});

function bigPlanTree(nodeCount: number) {
  let node = { name: 'Scan parquet', detail: 'Scan parquet', metrics: [], children: [] as unknown[] };
  for (let i = 0; i < nodeCount - 1; i++) {
    node = { name: `Filter${i}`, detail: `Filter${i}`, metrics: [], children: [node] };
  }
  return node;
}

// Two stages share one sql execution with a single segment; segment-to-stage
// pairing (ascending submittedAt) gives the only slot to stage 99, so stage
// 21's 'segment' request resolves to 'full' with requestedScope still
// 'segment', the state that disables "Back to segment view" (backDisabled).
// Uses stageId 21 (untouched above) because memoizedBuildPlanGraphModel caches
// on (activeFileId, stageId, scope); reusing 7 would return an earlier model.
function competingStageAppModel(nodeCount: number): AppModel {
  const appModel = singleStageAppModel(21);
  appModel.stages.set(21, { id: 21, sqlExecutionId: 1, submittedAt: 200, completedAt: 300 } as never);
  appModel.stages.set(99, { id: 99, sqlExecutionId: 1, submittedAt: 100, completedAt: 150 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(nodeCount) } as never);
  return appModel;
}

test('disabled "Back to segment view" button has a visible, accessible explanation', () => {
  renderRoute(
    <PlanGraphRoute
      stageId={21}
      appModel={competingStageAppModel(10)}
      findings={[]}
      activeFileId={null}
      onClose={vi.fn()}
    />,
  );

  const backBtn = screen.getByRole('button', { name: /back to segment view/i });
  expect(backBtn).toBeDisabled();

  const describedById = backBtn.getAttribute('aria-describedby');
  expect(describedById).toBeTruthy();

  const reason = screen.getByText("This stage's plan couldn't be scoped to a single segment");
  expect(reason.id).toBe(describedById);
});
