// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphCanvas } from '../../src/view/plan-graph/PlanGraphCanvas';
import { layoutWithDagre, runDagre, clearLayoutCache } from '../../src/view/plan-graph/dagre-layout';
import { WORKER_LAYOUT_MIN_NODES, overrideLayoutWorkerFactory } from '../../src/view/plan-graph/layout-worker-client';
import * as dagreLayout from '../../src/view/plan-graph/dagre-layout';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { StageSelectionProvider } from '../../src/view/plan-graph/stage-selection';
import type { PlanGraphModel } from '@sparkforensics/core/types.ts';
import { installInterpretation } from './_shared/interpretation';

function transformX(testId: string): number {
  return translateOf(testId).x;
}

function translateOf(testId: string): { x: number; y: number } {
  const el = screen.getByTestId(testId);
  const match = el.getAttribute('style')?.match(/translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px/);
  if (!match) throw new Error(`no transform found on ${testId}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

const setCenterMock = vi.fn();
const getNodeMock = vi.fn();
const fitViewMock = vi.hoisted(() => vi.fn());
const miniMapSpy = vi.hoisted(() => vi.fn());
// When set, the canvas treats its nodes as measured (jsdom measures none).
const nodesInitializedOverride = vi.hoisted(() => ({ current: null as null | boolean }));
// When set, the canvas reads this React Flow store state (canvas size and
// viewport transform) instead of jsdom's unmeasured zero-size canvas.
const storeOverride = vi.hoisted(() => ({ current: null as null | { width: number; height: number; transform: [number, number, number] } }));
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    useNodesInitialized: (() => {
      const measured = actual.useNodesInitialized();
      return nodesInitializedOverride.current ?? measured;
    }) as typeof actual.useNodesInitialized,
    useReactFlow: () => ({ setCenter: setCenterMock, getNode: getNodeMock, getZoom: () => 1, zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: fitViewMock, getNodes: () => [], setViewport: vi.fn() }),
    useStore: ((selector: (s: unknown) => unknown, equalityFn?: (a: unknown, b: unknown) => boolean) =>
      storeOverride.current ? selector(storeOverride.current) : actual.useStore(selector as never, equalityFn)) as typeof actual.useStore,
    MiniMap: (props: Record<string, unknown>) => {
      miniMapSpy(props);
      return <div data-testid="rf__minimap" />;
    },
  };
});

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// xyflow reads the viewport zoom off a DOMMatrixReadOnly when a node's handle
// bounds change, which happens when a layout stacks the graph (handles move to
// the top and bottom edges). jsdom has none; a unit matrix is enough here.
if (!('DOMMatrixReadOnly' in window)) {
  (window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m22 = 1;
  };
}

function model(overrides: Partial<PlanGraphModel> = {}): PlanGraphModel {
  return {
    nodes: [
      { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 100 },
      { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 200 },
    ],
    edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    segmentIndex: 0, segmentCount: 1, scope: 'segment', segmentStageIds: new Map(), inheritedSegments: new Set(), stageDurations: new Map(),
    ...overrides,
  };
}

describe('PlanGraphCanvas', () => {
  it('renders one node per model node', () => {
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    expect(screen.getByText('Scan parquet')).toBeInTheDocument();
    expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
  });

  it('computes duration-share percentage relative to the model total', () => {
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    expect(screen.getAllByText('33%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('67%').length).toBeGreaterThan(0);
  });

  it('shows the MiniMap only when showMiniMap is true', () => {
    const { rerender } = render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    expect(screen.queryByTestId('rf__minimap')).not.toBeInTheDocument();

    rerender(<PlanGraphCanvas model={model()} showMiniMap stageId={1} />);
    expect(screen.getByTestId('rf__minimap')).toBeInTheDocument();
  });

  it('makes the MiniMap a pan-and-zoom viewport control', () => {
    miniMapSpy.mockClear();
    render(<PlanGraphCanvas model={model()} showMiniMap stageId={1} />);

    expect(miniMapSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      pannable: true,
      zoomable: true,
      ariaLabel: 'Plan overview. Drag to pan and scroll to zoom the graph.',
    }));
  });

  it('colors MiniMap nodes by finding band (a function, not a flat color)', () => {
    miniMapSpy.mockClear();
    render(<PlanGraphCanvas model={model()} showMiniMap stageId={1} />);
    const { nodeColor } = miniMapSpy.mock.lastCall![0] as { nodeColor: unknown };
    expect(typeof nodeColor).toBe('function');
  });

  it('gives each plan node wrapper an aria-label summarizing operator/detail/duration', () => {
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    const wrapper = screen.getByTestId('rf__node-a');
    expect(wrapper).toHaveAttribute('aria-label', "Scan parquet, 33% of the plan's total stage duration");
  });
});

describe('focus nav', () => {
  it('renders "Next worst duration" enabled when there is a duration node', () => {
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    expect(screen.getByRole('button', { name: /next worst duration/i })).toBeEnabled();
  });

  it('hides "Next problem" entirely in single-stage (segment scope) view, even when findings are passed', () => {
    const findings = [{ type: 'skew' as const, stageId: 1, impactBand: 'critical' as const }];
    render(<PlanGraphCanvas model={model({ scope: 'segment' })} showMiniMap={false} stageId={1} findings={findings} />);
    expect(screen.queryByRole('button', { name: /next problem/i })).not.toBeInTheDocument();
  });

  it('hides "Next problem" in expanded (full) scope when the focal stage has no findings', () => {
    render(<PlanGraphCanvas model={model({ scope: 'full' })} showMiniMap={false} stageId={1} findings={[]} />);
    expect(screen.queryByRole('button', { name: /next problem/i })).not.toBeInTheDocument();
  });

  it('centers a paired-node jump on the middle of the target node', () => {
    setCenterMock.mockClear();
    getNodeMock.mockImplementation((id: string) => (id === 'b' ? { id: 'b', position: { x: 100, y: 50 }, measured: { width: 220, height: 60 }, data: {} } : undefined));
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} centerRequest={{ nodeId: 'b', token: 1 }} />);
    expect(setCenterMock).toHaveBeenCalledWith(210, 80, expect.objectContaining({ zoom: 1 }));
  });

  it('shows "Next problem" in expanded scope when the focal stage has findings, and it jumps to the stage box', async () => {
    const user = userEvent.setup();
    setCenterMock.mockClear();
    const findings = [{ type: 'skew' as const, stageId: 1, impactBand: 'critical' as const }];
    const segmentStageIds = new Map([[0, 1]]);
    render(
      <PlanGraphCanvas
        model={model({ scope: 'full', segmentStageIds })}
        showMiniMap={false}
        stageId={1}
        findings={findings}
        segmentStageIds={segmentStageIds}
      />,
    );
    const btn = screen.getByRole('button', { name: /next problem/i });
    await user.click(btn);
    expect(setCenterMock).toHaveBeenCalledTimes(1);
  });

  it('orders "Next problem" in verdict order, jumping to the stage with the most task time first', async () => {
    const user = userEvent.setup();
    setCenterMock.mockClear();
    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 100 },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: 200 },
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
      scope: 'full',
    });
    const segmentStageIds = new Map([[0, 7], [1, 8]]);
    // Stage 8 carries far more task time than stage 7, so its finding must be the first
    // "Next problem" target regardless of node/list order.
    const findings = [
      { type: 'skew' as const, stageId: 7, impactBand: 'warning' as const, recommendation: 'Fix it.', impactEstimate: { basis: 'serial' as const, wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' as const, stageTaskMs: 1000 } },
      { type: 'spill' as const, stageId: 8, impactBand: 'warning' as const, recommendation: 'Fix it.', impactEstimate: { basis: 'serial' as const, wallClock: { low: 90000, high: 90000 }, estimateMethod: 'measured' as const, stageTaskMs: 9000 } },
    ];
    installInterpretation(findings);
    render(<PlanGraphCanvas model={grouped} showMiniMap={false} stageId={7} findings={findings} segmentStageIds={segmentStageIds} />);

    await user.click(screen.getByRole('button', { name: /next problem/i }));

    const stage8 = screen.getByTestId('rf__node-stage-8');
    const match = stage8.getAttribute('style')?.match(/translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px/);
    expect(match).toBeTruthy();
    expect(setCenterMock).toHaveBeenCalledWith(Number(match![1]), Number(match![2]), expect.anything());
  });

  it('cycles "Next worst duration" through every duration node instead of re-centering on the same one, then wraps around', async () => {
    const user = userEvent.setup();
    setCenterMock.mockClear();
    const threeNodes = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 100 },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 300 },
        { id: 'c', sourceNodeId: 'c', label: 'Aggregate', category: 'aggregate', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 200 },
      ],
      edges: [],
    });
    render(<PlanGraphCanvas model={threeNodes} showMiniMap={false} stageId={1} />);
    const btn = screen.getByRole('button', { name: /next worst duration/i });

    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);

    expect(setCenterMock).toHaveBeenCalledTimes(4);
    const targets = setCenterMock.mock.calls.map(([x, y]) => `${x},${y}`);
    expect(new Set(targets.slice(0, 3)).size).toBe(3);
    expect(targets[3]).toBe(targets[0]);
  });
});

describe('compound stage-group containers', () => {
  it('paints each stage\'s id and duration on its stage box, and no header on the segment boxes', () => {
    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 500 },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: null },
      ],
      edges: [],
      scope: 'full',
      stageDurations: new Map([[42, 500]]),
    });
    const segmentStageIds = new Map([[0, 42], [1, 43]]);

    render(<PlanGraphCanvas model={grouped} showMiniMap={false} stageId={42} segmentStageIds={segmentStageIds} />);

    const stage42 = within(screen.getByTestId('rf__node-stage-42'));
    const stage43 = within(screen.getByTestId('rf__node-stage-43'));
    expect(stage42.getByText('Stage 42')).toBeInTheDocument();
    expect(stage43.getByText('Stage 43')).toBeInTheDocument();
    expect(stage42.getByText(formatDuration(500))).toBeInTheDocument();
    expect(stage43.queryByText('—')).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Stage \d+$/)).toHaveLength(2);
    expect(screen.queryByTestId('rf__node-segment-0')).not.toBeInTheDocument();
  });

  it('draws one stage box in single-stage scope and one per stage in full scope, leaving an inherited segment out of every stage box', () => {
    const single = model({ scope: 'segment' });
    const { rerender } = render(<PlanGraphCanvas model={single} showMiniMap={false} stageId={1} segmentStageIds={new Map([[0, 1]])} />);
    expect(screen.getAllByTestId(/rf__node-stage-/)).toHaveLength(1);

    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 500 },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: 300 },
        { id: 'c', sourceNodeId: 'c', label: 'Filter', category: 'filter', operatorDetail: '', primaryMetric: '', segmentIndex: 2, splitRole: null, durationShare: 200 },
      ],
      edges: [],
      scope: 'full',
      stageDurations: new Map([[42, 800], [43, 200]]),
    });
    const segmentStageIds = new Map([[0, 42], [1, 43], [2, 42]]);
    rerender(<PlanGraphCanvas model={{ ...grouped, inheritedSegments: new Set([2]) }} showMiniMap={false} stageId={42} segmentStageIds={segmentStageIds} />);

    expect(screen.getAllByTestId(/rf__node-stage-/)).toHaveLength(2);
    expect(within(screen.getByTestId('rf__node-stage-42')).getByText('Stage 42')).toBeInTheDocument();
    expect(within(screen.getByTestId('rf__node-stage-43')).getByText('Stage 43')).toBeInTheDocument();
    expect(within(screen.getByTestId('rf__node-stage-42')).getByText(formatDuration(800))).toBeInTheDocument();
  });

  it('draws an inherited segment as an unmatched dashed box that names the nearest stage', () => {
    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 500 },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: null },
      ],
      edges: [],
      scope: 'full',
      inheritedSegments: new Set([1]),
    });
    render(<PlanGraphCanvas model={grouped} showMiniMap={false} stageId={42} segmentStageIds={new Map([[0, 42], [1, 42]])} />);

    const unmatched = within(screen.getByTestId('rf__node-segment-1'));
    expect(unmatched.getByText('Stage —')).toBeInTheDocument();
    expect(unmatched.getByText('nearest: Stage 42')).toBeInTheDocument();
    expect(screen.getAllByTestId(/rf__node-stage-/)).toHaveLength(1);
    expect(screen.getAllByText('Stage 42')).toHaveLength(1);
  });

  it('draws a segment with no stage at all as an unmatched box that names no stage', () => {
    render(<PlanGraphCanvas model={model({ scope: 'full' })} showMiniMap={false} stageId={1} segmentStageIds={new Map()} />);

    expect(within(screen.getByTestId('rf__node-segment-0')).getByText('Stage —')).toBeInTheDocument();
    expect(screen.queryByText(/nearest/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/rf__node-stage-/)).not.toBeInTheDocument();
  });

  describe('a stage box never encloses a node of another stage', () => {
    // The shape of a log whose middle stage is missing: the root segment (0) has
    // no stage pair and inherits stage 5 from segment 1, while segment 2 sits
    // between them.
    const planNode = (id: string, segmentIndex: number) => ({
      id, sourceNodeId: id, label: id, category: 'transform', operatorDetail: '', primaryMetric: '', segmentIndex, splitRole: null, durationShare: null,
    });
    const reproduction = (inheritedSegments: Set<number>) => model({
      scope: 'full',
      nodes: [
        planNode('join', 0), planNode('read1', 0), planNode('read2', 0),
        planNode('write1', 1), planNode('range1', 1),
        planNode('write2', 2), planNode('filter2', 2), planNode('range2', 2),
      ],
      edges: [
        { id: 'join->read1', source: 'join', target: 'read1' }, { id: 'join->read2', source: 'join', target: 'read2' },
        { id: 'read1->write1', source: 'read1', target: 'write1' }, { id: 'write1->range1', source: 'write1', target: 'range1' },
        { id: 'read2->write2', source: 'read2', target: 'write2' }, { id: 'write2->filter2', source: 'write2', target: 'filter2' },
        { id: 'filter2->range2', source: 'filter2', target: 'range2' },
      ],
      inheritedSegments,
    });
    const segmentStageIds = new Map([[0, 5], [1, 5], [2, 9]]);
    const planNodeIds = ['join', 'read1', 'read2', 'write1', 'range1', 'write2', 'filter2', 'range2'];

    const enclosed = (stageTestId: string, nodeIds: string[]) => {
      const box = translateOf(stageTestId);
      const el = screen.getByTestId(stageTestId);
      const w = parseFloat(el.style.width);
      const h = parseFloat(el.style.height);
      return nodeIds.filter((id) => {
        const n = translateOf(`rf__node-${id}`);
        return n.x < box.x + w && n.x + dagreLayout.NODE_WIDTH > box.x && n.y < box.y + h && n.y + dagreLayout.NODE_HEIGHT > box.y;
      });
    };

    it('keeps stage 5 off the nodes of stage 9 and of the unmatched root segment', () => {
      render(<PlanGraphCanvas model={reproduction(new Set([0]))} showMiniMap={false} stageId={5} segmentStageIds={segmentStageIds} />);

      expect(enclosed('rf__node-stage-5', planNodeIds.filter((id) => !['write1', 'range1'].includes(id)))).toEqual([]);
      expect(enclosed('rf__node-stage-9', planNodeIds.filter((id) => !['write2', 'filter2', 'range2'].includes(id)))).toEqual([]);
    });

    it('would have enclosed them when the inherited segment counted as part of stage 5', () => {
      render(<PlanGraphCanvas model={reproduction(new Set())} showMiniMap={false} stageId={5} segmentStageIds={segmentStageIds} />);

      expect(enclosed('rf__node-stage-5', ['write2', 'filter2', 'range2'])).not.toEqual([]);
    });
  });

  it('shows a stage\'s full summed duration in the single-stage view, not the shown segment\'s share', () => {
    const single = model({ scope: 'segment', stageDurations: new Map([[7, 30000]]) });
    render(<PlanGraphCanvas model={single} showMiniMap={false} stageId={7} segmentStageIds={new Map([[0, 7], [1, 7]])} />);

    const stage7 = within(screen.getByTestId('rf__node-stage-7'));
    expect(stage7.getByText(formatDuration(30000))).toBeInTheDocument();
    expect(stage7.queryByText(formatDuration(300))).not.toBeInTheDocument();
  });

  it('pads a stage box 64px above and 32px below its plan nodes', () => {
    const grouped = model({ scope: 'full' });
    render(<PlanGraphCanvas model={grouped} showMiniMap={false} stageId={1} segmentStageIds={new Map([[0, 1]])} />);

    expect(parseFloat(screen.getByTestId('rf__node-stage-1').style.height))
      .toBe(dagreLayout.NODE_HEIGHT + dagreLayout.STAGE_GROUP_PADDING_Y + dagreLayout.STAGE_GROUP_PADDING_BOTTOM);
  });

  it('in single-stage (segment) scope, shows the focal stage\'s findings on the stage box', () => {
    const single = model({ scope: 'segment', segmentStageIds: new Map([[0, 7]]) });
    const findings = [{ type: 'skew' as const, stageId: 7, impactBand: 'critical' as const }];

    render(<PlanGraphCanvas model={single} showMiniMap={false} stageId={7} findings={findings} segmentStageIds={new Map([[0, 7]])} />);

    expect(within(screen.getByTestId('rf__node-stage-7')).getByText('SKEW')).toBeInTheDocument();
  });

  it('selects the stage with the chip as the entry when a finding chip is clicked', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const single = model({ scope: 'segment', segmentStageIds: new Map([[0, 7]]) });
    const findings = [{ type: 'skew' as const, stageId: 7, impactBand: 'critical' as const }];

    render(
      <StageSelectionProvider value={{ selectedStageId: null, select }}>
        <PlanGraphCanvas model={single} showMiniMap={false} stageId={7} findings={findings} segmentStageIds={new Map([[0, 7]])} />
      </StageSelectionProvider>,
    );

    const chip = screen.getByRole('button', { name: 'SKEW' });
    await user.click(chip);

    expect(select).toHaveBeenCalledWith(7, chip);
  });

  it('keeps the focal stage box and its findings when foreground filtering hides every plan node', () => {
    const single = model({
      scope: 'segment',
      segmentStageIds: new Map([[0, 7]]),
    });
    const findings = [{ type: 'skew' as const, stageId: 7, impactBand: 'critical' as const }];

    render(
      <PlanGraphCanvas
        model={single}
        showMiniMap={false}
        stageId={7}
        findings={findings}
        segmentStageIds={new Map([[0, 7]])}
        visibleNodeIds={new Set()}
        visibleEdges={[]}
      />,
    );

    expect(within(screen.getByTestId('rf__node-stage-7')).getByText('SKEW')).toBeInTheDocument();
    expect(screen.queryByTestId('rf__node-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rf__node-b')).not.toBeInTheDocument();
  });

  it('in expanded (full) scope, shows each finding once, on its stage box', () => {
    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: null },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: null },
      ],
      edges: [],
      scope: 'full',
    });
    const segmentStageIds = new Map([[0, 7], [1, 8]]);
    const findings = [{ type: 'skew' as const, stageId: 7, impactBand: 'critical' as const }];

    render(<PlanGraphCanvas model={grouped} showMiniMap={false} stageId={7} findings={findings} segmentStageIds={segmentStageIds} />);

    // Exactly one "SKEW" chip on screen, and it's inside stage 7's box.
    expect(screen.getAllByText('SKEW')).toHaveLength(1);
    expect(within(screen.getByTestId('rf__node-stage-7')).getByText('SKEW')).toBeInTheDocument();
    expect(within(screen.getByTestId('rf__node-stage-8')).queryByText('SKEW')).not.toBeInTheDocument();
  });

  it('keeps the focal stage box and Next problem target when foreground filtering hides that stage\'s operators', () => {
    const grouped = model({
      nodes: [
        { id: 'focal', sourceNodeId: 'focal', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 100 },
        { id: 'other', sourceNodeId: 'other', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: 200 },
      ],
      edges: [],
      scope: 'full',
    });
    const segmentStageIds = new Map([[0, 7], [1, 8]]);
    const findings = [{ type: 'skew' as const, stageId: 7, impactBand: 'critical' as const }];

    render(
      <PlanGraphCanvas
        model={grouped}
        showMiniMap={false}
        stageId={7}
        findings={findings}
        segmentStageIds={segmentStageIds}
        visibleNodeIds={new Set(['other'])}
        visibleEdges={[]}
      />,
    );

    expect(within(screen.getByTestId('rf__node-stage-7')).getByText('SKEW')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next problem/i })).toBeInTheDocument();
    expect(screen.queryByTestId('rf__node-focal')).not.toBeInTheDocument();
    expect(screen.getByTestId('rf__node-other')).toBeInTheDocument();
    expect(within(screen.getByTestId('rf__node-other')).getByTestId('duration-heat-bar-fill')).toHaveStyle({ width: '67%' });
  });

  it('compacts visible node positions instead of leaving gaps where filtered-out nodes used to sit', () => {
    const chainNode = (id: string) => ({
      id, sourceNodeId: id, label: id, category: 'transform', operatorDetail: '', primaryMetric: '',
      segmentIndex: 0, splitRole: null, durationShare: null,
    });
    const chain = model({
      nodes: [chainNode('a'), chainNode('b'), chainNode('c'), chainNode('d')],
      edges: [
        { id: 'a->b', source: 'a', target: 'b' },
        { id: 'b->c', source: 'b', target: 'c' },
        { id: 'c->d', source: 'c', target: 'd' },
      ],
    });
    const collapsedEdge = [{ id: 'a->d', source: 'a', target: 'd' }];

    render(
      <PlanGraphCanvas
        model={chain}
        showMiniMap={false}
        stageId={1}
        visibleNodeIds={new Set(['a', 'd'])}
        visibleEdges={collapsedEdge}
      />,
    );

    // Oracle: laying out only the two surviving nodes with their collapsed
    // edge, exactly like a filtered 2-node subgraph would compact on its
    // own, not the 4-node chain's original spread-out positions.
    const compact = layoutWithDagre(
      [chainNode('a'), chainNode('d')],
      collapsedEdge,
      { groupOf: () => 'segment-0' },
    );

    expect(transformX('rf__node-a')).toBeCloseTo(compact.find((n) => n.id === 'a')!.position.x, 5);
    expect(transformX('rf__node-d')).toBeCloseTo(compact.find((n) => n.id === 'd')!.position.x, 5);
  });

  it('creates a focal finding box and Next problem target when full-scope fallback has no focal segment mapping', () => {
    const fullFallback = model({
      scope: 'full',
      segmentStageIds: new Map([[0, 99]]),
    });
    const findings = [{ type: 'skew' as const, stageId: 7, impactBand: 'critical' as const }];

    render(
      <PlanGraphCanvas
        model={fullFallback}
        showMiniMap={false}
        stageId={7}
        findings={findings}
        segmentStageIds={new Map([[0, 99]])}
      />,
    );

    expect(within(screen.getByTestId('rf__node-stage-7')).getByText('SKEW')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next problem/i })).toBeInTheDocument();
  });

  it('stacks the whole-graph focal fallback box under the stage boxes it wraps, so their titles stay clickable', () => {
    const fullFallback = model({ scope: 'full', segmentStageIds: new Map([[0, 99]]) });
    const findings = [{ type: 'skew' as const, stageId: 7, impactBand: 'critical' as const }];

    render(
      <PlanGraphCanvas
        model={fullFallback}
        showMiniMap={false}
        stageId={7}
        findings={findings}
        segmentStageIds={new Map([[0, 99]])}
      />,
    );

    const zIndexOf = (testId: string) => Number(screen.getByTestId(testId).style.zIndex);
    expect(zIndexOf('rf__node-stage-7')).toBeLessThan(zIndexOf('rf__node-stage-99'));
  });

  it('paints a stage box that starts inside another stage box above it, so its title stays clickable', () => {
    // Stage 5's segments sit on either side of stage 9's, so stage 5's box wraps
    // stage 9's box and the "Stage 9" title lies under stage 5's overlay.
    const wrapping = model({
      nodes: [
        // Stage 9's node comes first, so its box is built first.
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: null },
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: null },
        { id: 'c', sourceNodeId: 'c', label: 'HashAggregate', category: 'aggregate', operatorDetail: '', primaryMetric: '', segmentIndex: 2, splitRole: null, durationShare: null },
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }, { id: 'b->c', source: 'b', target: 'c' }],
      scope: 'full',
    });

    render(<PlanGraphCanvas model={wrapping} showMiniMap={false} stageId={5} segmentStageIds={new Map([[0, 5], [1, 9], [2, 5]])} onSelectStage={vi.fn()} />);

    const stage5 = screen.getByTestId('rf__node-stage-5');
    const stage9 = screen.getByTestId('rf__node-stage-9');
    // Same z index, so React Flow's render order is the paint order.
    expect(stage5.style.zIndex).toBe(stage9.style.zIndex);
    expect(stage5.compareDocumentPosition(stage9) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('onSelectStage', () => {
  it('calls onSelectStage with the clicked stage id, in full scope', async () => {
    const user = userEvent.setup();
    const onSelectStage = vi.fn();
    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: null },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: null },
      ],
      edges: [],
      scope: 'full',
    });
    const segmentStageIds = new Map([[0, 7], [1, 8]]);

    render(
      <PlanGraphCanvas
        model={grouped}
        showMiniMap={false}
        stageId={7}
        segmentStageIds={segmentStageIds}
        onSelectStage={onSelectStage}
      />,
    );

    await user.click(within(screen.getByTestId('rf__node-stage-8')).getByRole('button', { name: /focus stage 8/i }));

    expect(onSelectStage).toHaveBeenCalledWith(8);
  });

  it('renders no clickable stage box in segment scope (nothing to select)', () => {
    render(<PlanGraphCanvas model={model({ scope: 'segment' })} showMiniMap={false} stageId={1} onSelectStage={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /focus stage/i })).not.toBeInTheDocument();
  });
});

describe('stage panel slot', () => {
  const originalMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });
  const panel = <div data-testid="stage-panel" />;

  it('renders the stage panel beside the graph', () => {
    render(<PlanGraphCanvas model={model()} showMiniMap stageId={1} stagePanel={panel} />);
    expect(screen.getByTestId('stage-panel')).toBeInTheDocument();
    expect(screen.getByTestId('rf__minimap')).toBeInTheDocument();
  });

  it('hides the minimap on a phone while the panel is up, as the node sheet does', () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    render(<PlanGraphCanvas model={model()} showMiniMap stageId={1} stagePanel={panel} />);
    expect(screen.getByTestId('stage-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('rf__minimap')).not.toBeInTheDocument();
  });
});

describe('node detail panel', () => {
  const detailModel = () =>
    model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: 'parquet', primaryMetric: '4.1M rows', segmentIndex: 0, splitRole: null, durationShare: 100, detailText: 'FileScan parquet db.sales[region#3] PushedFilters=[IsNotNull(region), region#3 IN (US,CA,GB)]', metrics: [{ name: 'number of output rows', value: '4,100,000' }] },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: 'Inner', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 200 },
      ],
    });

  it('renders the detail card for the selected node, showing its full plan detail', () => {
    render(<PlanGraphCanvas model={detailModel()} showMiniMap={false} stageId={1} selectedNodeId="a" onSelectNode={vi.fn()} />);
    const detail = screen.getByTestId('plan-node-detail');
    // The value is truncated on the node box (title attr only) but shown whole here.
    expect(within(detail).getByTestId('plan-node-detail-text')).toHaveTextContent(
      'PushedFilters=[IsNotNull(region), region#3 IN (US,CA,GB)]',
    );
  });

  it('renders no detail card when nothing is selected', () => {
    render(<PlanGraphCanvas model={detailModel()} showMiniMap={false} stageId={1} selectedNodeId={null} onSelectNode={vi.fn()} />);
    expect(screen.queryByTestId('plan-node-detail')).not.toBeInTheDocument();
  });

  it('renders no detail card for a selected id absent from the model (e.g. filtered out)', () => {
    render(<PlanGraphCanvas model={detailModel()} showMiniMap={false} stageId={1} selectedNodeId="gone" onSelectNode={vi.fn()} />);
    expect(screen.queryByTestId('plan-node-detail')).not.toBeInTheDocument();
  });

  it('calls onSelectNode with the id of a clicked plan node', () => {
    const onSelectNode = vi.fn();
    render(<PlanGraphCanvas model={detailModel()} showMiniMap={false} stageId={1} onSelectNode={onSelectNode} />);
    // A plain click event (not userEvent's pointer/mousedown sequence): the
    // nodes are draggable:false and xyflow's onNodeClick fires on click, and
    // this avoids d3-drag's mousedown path, which throws under jsdom (no
    // defaultView) but is inert in a real browser.
    fireEvent.click(within(screen.getByTestId('rf__node-b')).getByText('SortMergeJoin'));
    expect(onSelectNode).toHaveBeenCalledWith('b');
  });

  it('closes the card via its close button', async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    render(<PlanGraphCanvas model={detailModel()} showMiniMap={false} stageId={1} selectedNodeId="a" onSelectNode={onSelectNode} />);
    await user.click(screen.getByRole('button', { name: /close node detail/i }));
    expect(onSelectNode).toHaveBeenCalledWith(null);
  });
});

describe('layout direction', () => {
  const chainIds = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
  const chainModel = (overrides: Partial<PlanGraphModel> = {}) =>
    model({
      nodes: chainIds.map((id, i) => ({ id, sourceNodeId: id, label: id, category: 'transform', operatorDetail: '', primaryMetric: '', segmentIndex: overrides.scope === 'full' ? i : 0, splitRole: null, durationShare: 10 })),
      edges: chainIds.slice(0, -1).map((id, i) => ({ id: `${id}->${chainIds[i + 1]}`, source: id, target: chainIds[i + 1] })),
      ...overrides,
    });
  const translate = (testId: string) => {
    const match = screen.getByTestId(testId).getAttribute('style')?.match(/translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/);
    if (!match) throw new Error(`no transform found on ${testId}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const original = { width: window.innerWidth, height: window.innerHeight, matchMedia: window.matchMedia };
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: original.height });
    window.matchMedia = original.matchMedia;
  });
  const setWindow = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  };
  const usePhoneViewport = () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  };

  // Desktop keeps one right-to-left flow at every size: an ancestor (the edge's
  // source) is always to the right of its descendant, and the plan is never cut
  // into rows.
  const expectOneRightToLeftRow = () => {
    const positions = chainIds.map((id) => translate(`rf__node-${id}`));
    expect(new Set(positions.map((p) => p.y)).size).toBe(1);
    chainIds.slice(0, -1).forEach((id, i) => {
      expect(translate(`rf__node-${id}`).x).toBeGreaterThan(translate(`rf__node-${chainIds[i + 1]}`).x);
    });
  };

  it.each([[1440, 900], [1024, 768], [700, 900]])('never wraps a long operator chain on a %ix%i desktop window', (width, height) => {
    setWindow(width, height);
    render(<PlanGraphCanvas model={chainModel()} showMiniMap={false} stageId={1} />);
    expectOneRightToLeftRow();
  });

  it('never wraps a long chain of stages in the full plan either', () => {
    setWindow(1440, 900);
    const segmentStageIds = new Map(chainIds.map((_, i) => [i, i + 1]));
    render(<PlanGraphCanvas model={chainModel({ scope: 'full' })} showMiniMap={false} stageId={1} segmentStageIds={segmentStageIds} />);
    expectOneRightToLeftRow();
  });

  it('stacks a long chain vertically on a phone-width viewport so it can be read at full size', () => {
    setWindow(390, 844);
    usePhoneViewport();
    render(<PlanGraphCanvas model={chainModel()} showMiniMap={false} stageId={1} />);
    const first = translate('rf__node-n0');
    const last = translate('rf__node-n7');
    expect(Math.abs(first.y - last.y)).toBeGreaterThan(Math.abs(first.x - last.x));
    // The consumer (n0, an edge source) sits below its producer.
    expect(first.y).toBeGreaterThan(last.y);
  });
});

describe('legend', () => {
  it('is collapsed by default and opens on click', async () => {
    const user = userEvent.setup();
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    // Collapsed so the ~450x190 px key does not cover a corner of the graph.
    expect(screen.queryByTestId('plan-graph-legend')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^legend$/i }));
    const legend = screen.getByTestId('plan-graph-legend');
    expect(within(legend).getByText('Operators')).toBeInTheDocument();
    expect(within(legend).getByText(/shuffle bytes/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /hide legend/i }));
    expect(screen.queryByTestId('plan-graph-legend')).not.toBeInTheDocument();
  });
});

describe('control rail', () => {
  it('gathers zoom, navigation, and settings into one rail', () => {
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fit to view/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next worst duration/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^settings$/i })).toBeInTheDocument();
  });

  it('fits to a full overview with no zoom floor from the rail', async () => {
    const user = userEvent.setup();
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    fitViewMock.mockClear();
    await user.click(screen.getByRole('button', { name: /fit to view/i }));
    expect(fitViewMock).toHaveBeenCalledTimes(1);
    expect(fitViewMock.mock.lastCall![0]).not.toHaveProperty('minZoom');
  });

  it('toggles the minimap from the rail', async () => {
    const user = userEvent.setup();
    render(<PlanGraphCanvas model={model()} showMiniMap stageId={1} />);
    expect(screen.getByTestId('rf__minimap')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /hide minimap/i }));
    expect(screen.queryByTestId('rf__minimap')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show minimap/i }));
    expect(screen.getByTestId('rf__minimap')).toBeInTheDocument();
  });
});

describe('minimap visibility', () => {
  afterEach(() => {
    storeOverride.current = null;
  });

  it('hides the minimap while the graph fits, with the toggle unpressed, and shows it on an explicit click', async () => {
    // The two-node graph, shrunk to half size near the top-left of a large canvas, fits.
    storeOverride.current = { width: 1400, height: 900, transform: [200, 200, 0.5] };
    const user = userEvent.setup();
    render(<PlanGraphCanvas model={model()} showMiniMap stageId={1} />);
    expect(screen.queryByTestId('rf__minimap')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show minimap/i })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: /show minimap/i }));
    expect(screen.getByTestId('rf__minimap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide minimap/i })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /hide minimap/i }));
    expect(screen.queryByTestId('rf__minimap')).not.toBeInTheDocument();
  });

  it('shows the minimap while part of the graph is off screen, with the toggle pressed', () => {
    storeOverride.current = { width: 300, height: 200, transform: [0, 0, 2] };
    render(<PlanGraphCanvas model={model()} showMiniMap stageId={1} />);
    expect(screen.getByTestId('rf__minimap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide minimap/i })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('layout cost (full-model fallback runs only when needed)', () => {
  // Two segments zipped to two stages; the basic filter hides one node but each
  // segment keeps a visible member. buildPlanGraphModel-style fixture built by hand.
  const twoSegments = () =>
    model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 100 },
        { id: 'b', sourceNodeId: 'b', label: 'Project', category: 'transform', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 50 },
        { id: 'c', sourceNodeId: 'c', label: 'Join', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: 200 },
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }, { id: 'b->c', source: 'b', target: 'c' }],
      scope: 'full',
    });
  const segmentStageIds = new Map([[0, 7], [1, 8]]);

  it('lays out once (skips the full-model fallback) when every segment keeps a visible member', () => {
    const spy = vi.spyOn(dagreLayout, 'layoutWithDagre');
    // 'b' hidden, but segment 0 still has 'a' and segment 1 still has 'c'.
    render(
      <PlanGraphCanvas
        model={twoSegments()}
        showMiniMap={false}
        stageId={7}
        segmentStageIds={segmentStageIds}
        visibleNodeIds={new Set(['a', 'c'])}
        visibleEdges={[{ id: 'a->c', source: 'a', target: 'c' }]}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('lays out twice (computes the fallback) when a whole segment is filtered out', () => {
    const spy = vi.spyOn(dagreLayout, 'layoutWithDagre');
    // Segment 1's only node 'c' is hidden, so its box position must come from
    // the full-model fallback layout.
    render(
      <PlanGraphCanvas
        model={twoSegments()}
        showMiniMap={false}
        stageId={7}
        segmentStageIds={segmentStageIds}
        visibleNodeIds={new Set(['a', 'b'])}
        visibleEdges={[{ id: 'a->b', source: 'a', target: 'b' }]}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('large graph laid out in the layout worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    storeOverride.current = null;
    nodesInitializedOverride.current = null;
  });

  // A chain of segment-grouped nodes at the size where layouts leave the main thread.
  function largeModel(): PlanGraphModel {
    const nodes = Array.from({ length: WORKER_LAYOUT_MIN_NODES + 10 }, (_, i) => ({
      id: `n${i}`, sourceNodeId: `n${i}`, label: `Op ${i}`, category: 'transform' as const, operatorDetail: '', primaryMetric: '',
      segmentIndex: Math.floor(i / 10), splitRole: null, durationShare: 1,
    }));
    const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id }));
    return model({ nodes, edges, scope: 'full' });
  }

  // The client keeps one worker for the module's lifetime, so a single fake that runs
  // the real layout serves every test here; each reply is held until the test flushes it.
  const replies: Array<() => void> = [];
  overrideLayoutWorkerFactory(() => {
    const fake = {
      onmessage: null as null | ((e: { data: unknown }) => void),
      onerror: null,
      onmessageerror: null,
      terminate() {},
      postMessage(message: { id: number; job: Parameters<typeof runDagre>[0] }) {
        const positions = [...runDagre(message.job)].map(([id, p]) => [id, p.x, p.y]);
        replies.push(() => fake.onmessage?.({ data: { id: message.id, positions } }));
      },
    };
    return fake as unknown as Worker;
  });
  beforeEach(() => {
    replies.length = 0;
    clearLayoutCache();
  });

  it('shows a centered progress bar with the layout message while the worker lays the graph out, then the graph', async () => {
    vi.stubGlobal('Worker', class {});

    render(<PlanGraphCanvas model={largeModel()} showMiniMap={false} stageId={1} />);
    const status = screen.getByRole('status', { name: 'Laying out plan graph' });
    expect(status).toHaveTextContent('Laying out plan graph…');
    const bar = within(status).getByRole('progressbar', { name: 'Layout progress' });
    // No percentage is known, so the bar is indeterminate.
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(status).toHaveClass('items-center', 'justify-center');
    expect(screen.queryByText('Op 0')).not.toBeInTheDocument();

    await act(async () => { replies.splice(0).forEach((reply) => reply()); });
    expect(await screen.findByText('Op 0')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Laying out plan graph' })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Layout progress' })).not.toBeInTheDocument();
  });

  it('fits the plan to the view like the Fit to view button, once, after the worker layout lands', async () => {
    vi.stubGlobal('Worker', class {});
    storeOverride.current = { width: 1400, height: 900, transform: [0, 0, 1] };
    nodesInitializedOverride.current = true;
    fitViewMock.mockClear();

    const { rerender } = render(<PlanGraphCanvas model={largeModel()} showMiniMap={false} stageId={1} />);
    // The layout is still running: the canvas is not mounted, so nothing can be fitted yet.
    expect(fitViewMock).not.toHaveBeenCalled();

    await act(async () => { replies.splice(0).forEach((reply) => reply()); });
    expect(await screen.findByText('Op 0')).toBeInTheDocument();
    expect(fitViewMock).toHaveBeenCalledTimes(1);
    // The same call as the rail button: a full overview with no zoom floor.
    expect(fitViewMock.mock.lastCall![0]).toEqual({ duration: 200 });

    rerender(<PlanGraphCanvas model={largeModel()} showMiniMap={false} stageId={1} fitSignal={0} />);
    expect(fitViewMock).toHaveBeenCalledTimes(1);
  });

  it('watches the graph container for resizes once the worker layout lands', async () => {
    vi.stubGlobal('Worker', class {});
    const observed: Element[] = [];
    vi.stubGlobal('ResizeObserver', class {
      observe(el: Element) { observed.push(el); }
      unobserve() {}
      disconnect() {}
    });

    render(<PlanGraphCanvas model={largeModel()} showMiniMap={false} stageId={1} />);
    await act(async () => { replies.splice(0).forEach((reply) => reply()); });
    const node = await screen.findByText('Op 0');
    const rail = screen.getByRole('button', { name: /fit to view/i });
    expect(observed.some((el) => el.isConnected && el.contains(node) && el.contains(rail))).toBe(true);
  });
});
