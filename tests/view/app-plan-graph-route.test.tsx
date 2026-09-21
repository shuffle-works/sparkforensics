// @vitest-environment jsdom
import { test, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';
import { store, emptyAppModel } from '@/store/store';
import { captureSnapshot } from '@sparkforensics/core/session-snapshot.ts';
import { clearPlanGraphModelCache } from '@/view/PlanGraphRoute';

// PlanGraphCanvas (React Flow) needs a ResizeObserver on mount; jsdom has none.
// Keep the stub file-scoped: a global one makes Recharts render 0×0 by dropping
// its initialDimension fallback, and this route never mounts chart widgets.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const recentFilesMock = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
  touch: vi.fn(async () => {}),
}));

vi.mock('@sparkforensics/core/recent-files.ts', () => ({
  isSupported: () => false,
  list: vi.fn(async () => recentFilesMock.entries),
  add: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
  touch: recentFilesMock.touch,
  getHandle: vi.fn(async () => null),
  ensurePermission: vi.fn(async () => true),
  entryId: (name: string, size: number, lastModified: number) => `${name}::${size}::${lastModified}`,
}));

function planTreePlanModel(stageId: number) {
  const planTree = { id: 'n0', name: 'SortMergeJoin', detail: 'SortMergeJoin', metrics: [], children: [] };
  const appModel = emptyAppModel();
  appModel.stages.set(stageId, { id: stageId, sqlExecutionId: 1 } as never);
  appModel.sql.set(1, { executionId: 1, planTree, stageIds: [stageId] } as never);
  return appModel;
}

async function waitForDashboard() {
  return screen.findByRole('tab', { name: 'Findings' });
}

beforeEach(() => {
  recentFilesMock.entries = [];
  recentFilesMock.touch.mockReset();
  recentFilesMock.touch.mockResolvedValue(undefined);
  store.getState().resetModel();
  store.setState({ sessionCache: new Map(), activeFileId: 'file-1', status: 'ready' });
  // Clear PlanGraphRoute's memo cache explicitly to isolate tests even if the
  // resetModel store.subscribe wiring that also evicts it changes.
  clearPlanGraphModelCache();
});

test('openPlanGraph shows an accessible loading state before resolving the full-screen PlanGraphRoute', async () => {
  store.setState({ appModel: planTreePlanModel(7) });
  store.getState().openPlanGraph(7);

  render(<App />);

  expect(screen.getByRole('status', { name: /loading plan graph/i })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: /plan graph/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Plan graph: Stage 7' })).toBeInTheDocument();
});

test('opening with initialScope "full" resolves the lazy route to the full graph without an additional click', async () => {
  store.setState({ appModel: planTreePlanModel(7) });
  store.getState().openPlanGraph(7, { initialScope: 'full' });

  render(<App />);

  expect(await screen.findByRole('button', { name: /back to segment view/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /expand to full plan/i })).not.toBeInTheDocument();
});

test('confirming an oversized initial full-scope request keeps the graph withheld until confirmation, then renders it', async () => {
  const user = userEvent.setup();
  const appModel = planTreePlanModel(7);
  appModel.app = { name: 'Oversized run' } as never;
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(320), stageIds: [7] } as never);
  store.setState({ appModel, status: 'ready' });

  render(<App />);
  await waitForDashboard();
  await user.click(screen.getByRole('button', { name: 'Plan graph' }));

  expect(await screen.findByRole('heading', { name: 'Expand to full plan?' })).toBeInTheDocument();
  expect(screen.getByText(/this plan has 320 nodes/i)).toBeInTheDocument();
  expect(screen.queryByText('Filter0')).not.toBeInTheDocument();
  expect(screen.queryByText(/couldn't build the plan graph/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /expand anyway/i }));

  expect(screen.queryByRole('heading', { name: 'Expand to full plan?' })).not.toBeInTheDocument();
  expect(await screen.findByText('Filter0')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /back to segment view/i })).toBeInTheDocument();
});

test('cancelling an oversized initial full-scope request reveals the segment graph instead', async () => {
  const user = userEvent.setup();
  const appModel = planTreePlanModel(7);
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(320), stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7, { initialScope: 'full' });

  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Expand to full plan?' })).toBeInTheDocument();
  expect(screen.queryByText('Filter0')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^cancel$/i }));

  expect(screen.queryByRole('heading', { name: 'Expand to full plan?' })).not.toBeInTheDocument();
  expect(await screen.findByText('Filter0')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /expand to full plan/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /back to segment view/i })).not.toBeInTheDocument();
});

test('picking a cached recent file closes the plan graph before restoring the next snapshot', async () => {
  const user = userEvent.setup();
  const currentModel = planTreePlanModel(7);
  currentModel.app = { name: 'Current run' } as never;
  const nextModel = planTreePlanModel(9);
  nextModel.app = { name: 'Cached run' } as never;
  const nextSnapshot = captureSnapshot(nextModel, [], new Map());

  recentFilesMock.entries = [{
    id: 'file-2',
    name: 'cached.ndjson',
    size: 100,
    lastModified: 2,
    appName: 'Cached run',
    issueCount: 0,
  }];
  // Keep pickRecent suspended after applySnapshot mutates the live appModel.
  // The graph must already be closed at that boundary, not only after the
  // asynchronous recent-file bookkeeping finishes.
  recentFilesMock.touch.mockReturnValueOnce(new Promise(() => {}));
  store.setState({
    appModel: currentModel,
    activeFileId: 'file-1',
    sessionCache: new Map([['file-2', nextSnapshot]]),
    status: 'ready',
  });
  store.getState().openPlanGraph(7);

  render(<App />);
  await user.click(screen.getByRole('button', { name: /current run/i }));
  await user.click(await screen.findByRole('button', { name: /cached run/i }));

  expect(store.getState().appModel.app?.name).toBe('Cached run');
  expect(store.getState().planGraph).toEqual({ active: false, stageId: null, initialScope: 'segment' });
});

test('opening a different stage remounts the route and resets its scope/focus state', () => {
  const appModel = planTreePlanModel(7);
  appModel.stages.set(9, { id: 9, sqlExecutionId: 2 } as never);
  appModel.sql.set(2, {
    executionId: 2,
    planTree: { id: 'n0', name: 'BroadcastHashJoin', detail: 'BroadcastHashJoin', metrics: [], children: [] },
    stageIds: [9],
  } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7, { initialScope: 'full' });

  const { rerender } = render(<App />);
  expect(screen.getByRole('heading', { name: 'Plan graph: Stage 7' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /back to segment view/i })).toBeInTheDocument();

  // Defaults to 'segment'. Without a remount key the previous instance's
  // requestedScope ('full') leaks in, since useState reads its initial only on mount.
  store.getState().openPlanGraph(9);
  rerender(<App />);

  expect(screen.getByRole('heading', { name: 'Plan graph: Stage 9' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /expand to full plan/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /back to segment view/i })).not.toBeInTheDocument();
});

test('the plan graph always opens on the segment view by default, never the full plan', () => {
  const appModel = planTreePlanModel(7);
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(10), stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);

  expect(screen.getByText(/segment 1 of 1/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /expand to full plan/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /back to segment view/i })).not.toBeInTheDocument();
});

test('closing the plan graph route returns to the plain dashboard', async () => {
  const user = userEvent.setup();
  store.setState({ appModel: planTreePlanModel(7) });
  store.getState().openPlanGraph(7);

  render(<App />);
  await user.click(screen.getByRole('button', { name: /close/i }));

  expect(screen.queryByRole('heading', { name: /plan graph/i })).not.toBeInTheDocument();
  expect(store.getState().planGraph.active).toBe(false);
});

test('renders the graph canvas with the plan node once opened', () => {
  store.setState({ appModel: planTreePlanModel(7) });
  store.getState().openPlanGraph(7);

  render(<App />);

  expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
});

// Regression: a finding badge's docs link on the plan-graph route (which
// renders instead of Dashboard) must open the app-level DocsSheet both routes share.
test('clicking a finding badge in the plan graph opens the reference panel', () => {
  const appModel = planTreePlanModel(7);
  const finding = { type: 'skew', stageId: 7, impactBand: 'critical' as const, recommendation: 'Rebalance partitions' };
  store.setState({ appModel, catalog: [finding] });
  store.getState().openPlanGraph(7);

  render(<App />);

  // fireEvent, not userEvent: userEvent.click's mousedown bubbles into React
  // Flow's pane, whose d3-drag zoom/pan throws on that synthetic event in jsdom.
  fireEvent.click(screen.getByRole('link', { name: 'SKEW' }));

  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('a finding that only carries stageIds (not stageId) still reaches the plan graph', () => {
  const appModel = planTreePlanModel(7);
  const finding = {
    type: 'smallFiles', stageId: null, stageIds: [7], impactBand: 'warning' as const,
    recommendation: 'Compact the upstream output',
  };
  store.setState({ appModel, catalog: [finding] });
  store.getState().openPlanGraph(7);

  render(<App />);

  expect(screen.getByText('PLAN')).toBeInTheDocument();
});

test('Basic filter mode hides boilerplate nodes by default', async () => {
  const user = userEvent.setup();
  const appModel = planTreePlanModel(7);
  // planTree with a boilerplate child to exercise Basic filter's category exclusion.
  const planTree = {
    id: 'n0', name: 'SortMergeJoin', detail: 'SortMergeJoin', metrics: [],
    children: [{ id: 'n1', name: 'WholeStageCodegen (1)', detail: 'WholeStageCodegen (1)', metrics: [], children: [] }],
  };
  appModel.sql.set(1, { executionId: 1, planTree, stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);

  expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
  expect(screen.queryByText('WholeStageCodegen (1)')).not.toBeInTheDocument();

  // The hidden-node count now lives inside the settings panel (see
  // PlanGraphSettingsControl), not inline in the topbar row.
  await user.click(screen.getByRole('button', { name: /settings/i }));
  expect(await screen.findByText(/1 nodes hidden/)).toBeInTheDocument();
});

// Regression: hiding a whole operator category (e.g. 'transform' pass-through
// nodes like Project) under 'io'/'basic' filters must reconnect edges around the
// hidden node, not drop every edge touching it and fragment the plan. React Flow
// renders no edge paths in jsdom; plan-graph-route-edge-filter.test.tsx asserts
// the actual edge set.
test('Basic filter mode hides a pass-through node but keeps its neighbors visible', () => {
  const appModel = planTreePlanModel(7);
  // SortMergeJoin (join, visible) -> Project (transform, hidden under Basic) -> Scan parquet (scan, visible).
  const planTree = {
    id: 'n0', name: 'SortMergeJoin', detail: 'SortMergeJoin', metrics: [],
    children: [{
      id: 'n1', name: 'Project', detail: 'Project', metrics: [],
      children: [{ id: 'n2', name: 'Scan parquet', detail: 'Scan parquet', metrics: [], children: [] }],
    }],
  };
  appModel.sql.set(1, { executionId: 1, planTree, stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);

  expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
  expect(screen.getByText('Scan parquet')).toBeInTheDocument();
  expect(screen.queryByText('Project')).not.toBeInTheDocument();
});

function bigPlanTree(nodeCount: number) {
  let node = { id: 'leaf', name: 'Scan parquet', detail: 'Scan parquet', metrics: [], children: [] as unknown[] };
  for (let i = 0; i < nodeCount - 1; i++) {
    node = { id: `f${i}`, name: `Filter${i}`, detail: `Filter${i}`, metrics: [], children: [node] };
  }
  return node;
}

test('expanding a plan over the 300-node threshold shows the guardrail dialog instead of expanding immediately', async () => {
  const user = userEvent.setup();
  const appModel = planTreePlanModel(7);
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(320), stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);
  await user.click(screen.getByRole('button', { name: /expand to full plan/i }));

  expect(screen.getByText(/320/)).toBeInTheDocument();
  expect(screen.getByText(/several seconds/i)).toBeInTheDocument();
  // Still segment-scoped underneath, the expand didn't proceed.
  expect(screen.getByText(/segment 1 of 1/i)).toBeInTheDocument();
});

// Regression: ExpandConfirmDialog closes on Escape without stopping propagation,
// so an unguarded route-level Escape handler would also tear down the whole route.
// The route handler is guarded with `!confirmExpandOpen`.
test('pressing Escape while the guardrail dialog is open closes only the dialog, not the whole plan-graph route', async () => {
  const user = userEvent.setup();
  const appModel = planTreePlanModel(7);
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(320), stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);
  await user.click(screen.getByRole('button', { name: /expand to full plan/i }));

  // Guardrail dialog is up.
  expect(screen.getByText(/several seconds/i)).toBeInTheDocument();

  // Escape while the dialog is open must close only the dialog...
  await user.keyboard('{Escape}');

  expect(screen.queryByText(/several seconds/i)).not.toBeInTheDocument();
  // ...and leave the plan-graph route itself fully intact.
  expect(screen.getByRole('heading', { name: /plan graph/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  expect(store.getState().planGraph.active).toBe(true);

  // With the dialog closed, a second Escape must still close the whole route.
  await user.keyboard('{Escape}');

  expect(screen.queryByRole('heading', { name: /plan graph/i })).not.toBeInTheDocument();
  expect(store.getState().planGraph.active).toBe(false);
});

test('expanding a plan under the 300-node threshold proceeds immediately with no dialog', async () => {
  const user = userEvent.setup();
  const appModel = planTreePlanModel(7);
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(10), stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);
  await user.click(screen.getByRole('button', { name: /expand to full plan/i }));

  expect(screen.queryByText(/several seconds/i)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /back to segment view/i })).toBeInTheDocument();
});

// Regression: "Back to segment view" after an explicit "Expand to full plan"
// must actually flip the view back, not just relabel the button.
test('clicking "Back to segment view" after an explicit expand actually returns to segment view', async () => {
  const user = userEvent.setup();
  const appModel = planTreePlanModel(7);
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(10), stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);
  await user.click(screen.getByRole('button', { name: /expand to full plan/i }));
  const backBtn = screen.getByRole('button', { name: /back to segment view/i });
  expect(backBtn).toBeEnabled();

  await user.click(backBtn);

  expect(screen.getByRole('button', { name: /expand to full plan/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /back to segment view/i })).not.toBeInTheDocument();
});

// buildPlanGraphModel derives linked stage ids via stageIdsForSqlExec, which
// always finds stage 7, so the single segment always zips to it. To force a
// genuine segment-lookup-failure fallback, add a second stage on the same sql
// execution with an earlier submittedAt: zipSegmentsToStages pairs by ascending
// submittedAt, so stage 99 wins the only pairing slot and stage 7 is unmatched.
function competingStageAppModel(nodeCount: number) {
  const appModel = planTreePlanModel(7);
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1, submittedAt: 200, completedAt: 300 } as never);
  appModel.stages.set(99, { id: 99, sqlExecutionId: 1, submittedAt: 100, completedAt: 150 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: bigPlanTree(nodeCount) } as never);
  return appModel;
}

test('a segment lookup failure on an oversized plan shows the guardrail dialog on its own, without an unguarded full render', () => {
  const appModel = competingStageAppModel(320);
  // The segment-lookup-failure fallback fires with no click; it must still be
  // gated by the same 300-node guardrail as an explicit "Expand to full plan".
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);

  expect(screen.getByText(/320/)).toBeInTheDocument();
  expect(screen.getByText(/several seconds/i)).toBeInTheDocument();
});

// The fallback-dismiss flag must only silence the dialog's auto-reopen effect,
// not lift the guardrail block on `model`; otherwise Cancel here would render
// the unguarded 320-node full-scope graph.
test('dismissing the guardrail dialog on a segment-lookup-failure fallback keeps the render blocked (no unguarded oversized graph)', async () => {
  const user = userEvent.setup();
  const appModel = competingStageAppModel(320);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);
  expect(screen.getByText(/several seconds/i)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^cancel$/i }));

  // The 320-node model must stay withheld: the block is keyed off the
  // oversized-fallback condition, not off whether the dialog is open.
  expect(screen.queryByText(/several seconds/i)).not.toBeInTheDocument();
  expect(screen.getByText(/more nodes than the graph view can safely render/i)).toBeInTheDocument();
  expect(screen.queryByText('Filter0')).not.toBeInTheDocument();
});

// An automatic segment-lookup-failure fallback whose full-scope model is under
// the 300-node threshold needs no guardrail dialog and renders immediately, with
// requestedScope left at 'segment'. The toggle label must reflect what's on
// screen (full plan), keyed off `model?.scope`, not the unclicked `requestedScope`.
test('an automatic segment-lookup-failure fallback that stays under the threshold renders immediately and labels the toggle "Back to segment view"', () => {
  const appModel = competingStageAppModel(10);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);

  // No guardrail dialog: 10 nodes is well under the 300-node threshold.
  expect(screen.queryByText(/several seconds/i)).not.toBeInTheDocument();
  // The fallback's full-scope content is already on screen...
  expect(screen.getByText('Filter0')).toBeInTheDocument();
  // ...so the toggle reads "Back to segment view" even though requestedScope is still 'segment'.
  const backBtn = screen.getByRole('button', { name: /back to segment view/i });
  expect(backBtn).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /expand to full plan/i })).not.toBeInTheDocument();
  // Regression: this stage's 'segment' request permanently resolves to 'full'
  // (no segment maps to it), so there is no segment view to switch back to; the
  // button must be disabled rather than a silent no-op.
  expect(backBtn).toBeDisabled();
});

test('an automatic under-threshold fallback keeps focal-stage findings reachable even when no segment maps to that stage', () => {
  const appModel = competingStageAppModel(10);
  const finding = { type: 'skew', stageId: 7, impactBand: 'critical' as const, recommendation: 'Rebalance partitions' };
  store.setState({ appModel, catalog: [finding] });
  store.getState().openPlanGraph(7);

  render(<App />);

  expect(screen.getByTestId('rf__node-stage-7')).toBeInTheDocument();
  expect(screen.getByText('SKEW')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /next problem/i })).toBeInTheDocument();
});

// Exchange splits the plan into two segments, zipped to two stages by ascending submittedAt.
// The Exchange must be a real read-wrapping-write pair (resolvePlanTree's split
// shape, see event-handlers.ts): computeSegments cuts on exchangeRole==='read'
// now, not a name regex, so a bare { name: 'Exchange...' } node would no
// longer cut a segment at all.
function twoStagePlanModel() {
  const leaf = { id: 'n0', name: 'Scan parquet', detail: 'Scan parquet', metrics: [], children: [] };
  const write = { id: 'n1', name: 'Exchange hashpartitioning', detail: '', metrics: [], children: [leaf], exchangeRole: 'write' };
  const exchange = { id: 'n2', name: 'Exchange hashpartitioning', detail: 'Exchange hashpartitioning', metrics: [], children: [write], exchangeRole: 'read' };
  const root = { id: 'n3', name: 'SortMergeJoin', detail: 'SortMergeJoin', metrics: [], children: [exchange] };
  const appModel = emptyAppModel();
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1, submittedAt: 0, completedAt: 500 } as never);
  appModel.stages.set(8, { id: 8, sqlExecutionId: 1, submittedAt: 500, completedAt: 1000 } as never);
  appModel.sql.set(1, { executionId: 1, planTree: root, stageIds: [7, 8] } as never);
  return appModel;
}

test('clicking a stage box in the full graph switches focus to that stage\'s segment view', async () => {
  const user = userEvent.setup();
  store.setState({ appModel: twoStagePlanModel() });
  store.getState().openPlanGraph(7, { initialScope: 'full' });

  render(<App />);
  expect(screen.getByRole('heading', { name: 'Plan graph: Stage 7' })).toBeInTheDocument();

  await user.click(within(screen.getByTestId('rf__node-stage-8')).getByRole('button', { name: /focus stage 8/i }));

  expect(screen.getByRole('heading', { name: 'Plan graph: Stage 8' })).toBeInTheDocument();
  expect(screen.getByText(/segment \d of \d/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /expand to full plan/i })).toBeInTheDocument();
});

// Regression: after selecting Stage 8, its segment box must show Stage 8's own
// findings, not the stale anchor Stage 7 findings.
test('selecting a stage from the full graph shows only that stage\'s findings', async () => {
  const appModel = twoStagePlanModel();
  store.setState({
    appModel,
    catalog: [
      { type: 'skew', stageId: 7, impactBand: 'critical' as const, recommendation: 'Rebalance partitions' },
      { type: 'shuffle', stageId: null, stageIds: [8], impactBand: 'warning' as const, recommendation: 'Reduce shuffle output' },
    ],
  });
  store.getState().openPlanGraph(7, { initialScope: 'full' });

  render(<App />);

  // Findings render in the matched segment box's header, so locate each by its
  // "Stage N" label rather than a fixed segment index.
  const segmentFor = (label: string) =>
    screen.getAllByTestId(/rf__node-segment-/).find((node) => within(node).queryByText(label));

  expect(within(segmentFor('Stage 7')!).getByText('SKEW')).toBeInTheDocument();
  expect(within(segmentFor('Stage 8')!).getByText('SHFL')).toBeInTheDocument();

  // fireEvent avoids d3-zoom's jsdom-incompatible pointer handling; the behavior
  // under test is the stage box's React handler, not React Flow's drag logic.
  fireEvent.click(within(screen.getByTestId('rf__node-stage-8')).getByRole('button', { name: /focus stage 8/i }));

  expect(screen.getByRole('heading', { name: 'Plan graph: Stage 8' })).toBeInTheDocument();
  expect(screen.getByText('SHFL')).toBeInTheDocument();
  expect(screen.queryByText('SKEW')).not.toBeInTheDocument();
});

// Proves memoization behaviorally (a vi.doMock spy can't reliably intercept
// re-renders once other tests have imported the module): mutate the planTree's
// object identity for the same stageId/activeFileId between two openPlanGraph(7)
// calls; the node still reflecting the *first* planTree proves the memo was reused.
test('re-opening the same stage does not rebuild the model (memoized per activeFileId/stageId/scope)', () => {
  const appModel = planTreePlanModel(7);
  store.setState({ appModel, activeFileId: 'file-1' });
  store.getState().openPlanGraph(7);
  const { unmount } = render(<App />);
  expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
  unmount();

  // Same cache key (stageId 7, activeFileId 'file-1', scope 'segment'), different planTree object.
  appModel.sql.get(1)!.planTree = {
    id: 'n0', name: 'BroadcastHashJoin', detail: 'BroadcastHashJoin', metrics: [], children: [],
  } as never;
  store.getState().openPlanGraph(7);
  render(<App />);

  expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
  expect(screen.queryByText('BroadcastHashJoin')).not.toBeInTheDocument();
});

// resetModel() must evict planGraphModelCache: after a reload, reopening the
// same stageId/activeFileId key must rebuild from the new planTree, not a stale
// pre-reset cache entry.
test('resetModel() clears the plan-graph memo cache, so a changed planTree for the same key is rebuilt on reopen', () => {
  const appModel = planTreePlanModel(7);
  store.setState({ appModel, activeFileId: 'file-1' });
  store.getState().openPlanGraph(7);
  const { unmount } = render(<App />);
  expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
  unmount();

  appModel.sql.get(1)!.planTree = {
    id: 'n0', name: 'BroadcastHashJoin', detail: 'BroadcastHashJoin', metrics: [], children: [],
  } as never;
  store.getState().resetModel();
  // resetModel() also clears appModel/activeFileId/planGraph; restore enough to
  // reopen against the same cache key as before the reset.
  store.setState({ appModel, activeFileId: 'file-1' });
  store.getState().openPlanGraph(7);
  render(<App />);

  expect(screen.getByText('BroadcastHashJoin')).toBeInTheDocument();
  expect(screen.queryByText('SortMergeJoin')).not.toBeInTheDocument();
});

// HashAggregate -> Filter -> Scan parquet, no Exchange in between: a single
// 3-node segment zipped onto stage 7's whole 900ms wall time. All three stay
// visible under the default 'basic' filter (aggregate/filter/scan are all
// allowed categories). With no per-operator timing metrics on any node,
// exclusive attribution splits the wall time evenly (300ms/node); hand-
// verified expected percentages:
//   exclusive: every node = 300/900 = 33% (a flat partition, by definition).
//   inclusive: HashAggregate (root) rolls up both descendants = 900/900 =
//     100%; Filter (middle) rolls up its one child = 600/900 = 67%; Scan
//     parquet (leaf, no descendants) is unchanged at 300/900 = 33%.
// This is a regression guard, not just a "some number changed" check: before
// the totalDuration-denominator fix (PlanGraphCanvas summed the mode-selected
// `durationShare`, which under inclusive mode already double/triple-counts
// descendants into ancestors), this same fixture would have produced 50% /
// 33% / 17% instead, silently shrinking the leaf's share and shorting the
// middle node's, exactly the bug this test would have caught.
test('re-renders the graph with hand-verified inclusive duration percentages after toggling the duration mode control', async () => {
  const user = userEvent.setup();
  const appModel = planTreePlanModel(7);
  const planTree = {
    id: 'n0', name: 'HashAggregate', detail: 'HashAggregate', metrics: [],
    children: [{
      id: 'n1', name: 'Filter', detail: 'Filter', metrics: [],
      children: [{ id: 'n2', name: 'Scan parquet', detail: 'Scan parquet', metrics: [], children: [] }],
    }],
  };
  appModel.stages.set(7, { id: 7, sqlExecutionId: 1, submittedAt: 0, completedAt: 900 } as never);
  appModel.sql.set(1, { executionId: 1, planTree, stageIds: [7] } as never);
  store.setState({ appModel });
  store.getState().openPlanGraph(7);

  render(<App />);

  // Pick the match inside a plan node (has a [data-category] ancestor), not the
  // now-open-by-default legend's operator-key entry with the same label text.
  const pctOf = (label: string) => {
    const node = screen.getAllByText(label).find((el) => el.closest('[data-category]'));
    return within(node!.closest('[data-category]') as HTMLElement)
      .getByTestId('duration-heat-bar-fill').style.width;
  };

  expect(pctOf('HashAggregate')).toBe('33%');
  expect(pctOf('Filter')).toBe('33%');
  expect(pctOf('Scan parquet')).toBe('33%');

  await user.click(screen.getByRole('button', { name: /settings/i }));
  await user.click(screen.getByRole('radio', { name: /node \+ descendants/i }));

  expect(pctOf('HashAggregate')).toBe('100%');
  expect(pctOf('Filter')).toBe('67%');
  expect(pctOf('Scan parquet')).toBe('33%');
});
