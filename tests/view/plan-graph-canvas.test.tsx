// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphCanvas } from '../../src/view/plan-graph/PlanGraphCanvas';
import { layoutWithDagre } from '../../src/view/plan-graph/dagre-layout';
import * as dagreLayout from '../../src/view/plan-graph/dagre-layout';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { docsUrl } from '@sparkforensics/core/docs-config.ts';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { DocsProvider } from '../../src/view/DocsContext';
import { DocsSheet } from '../../src/view/DocsSheet';
import type { PlanGraphModel } from '@sparkforensics/core/types.ts';

function transformX(testId: string): number {
  const el = screen.getByTestId(testId);
  const match = el.getAttribute('style')?.match(/translate\((-?\d+(?:\.\d+)?)px/);
  if (!match) throw new Error(`no transform found on ${testId}`);
  return Number(match[1]);
}

const setCenterMock = vi.fn();
const miniMapSpy = vi.hoisted(() => vi.fn());
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    useReactFlow: () => ({ setCenter: setCenterMock, zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn() }),
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

function model(overrides: Partial<PlanGraphModel> = {}): PlanGraphModel {
  return {
    nodes: [
      { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 100 },
      { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 200 },
    ],
    edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    segmentIndex: 0, segmentCount: 1, scope: 'segment', segmentStageIds: new Map(),
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
    const findings = [{ type: 'skew', stageId: 1, impactBand: 'critical' as const }];
    render(<PlanGraphCanvas model={model({ scope: 'segment' })} showMiniMap={false} stageId={1} findings={findings} />);
    expect(screen.queryByRole('button', { name: /next problem/i })).not.toBeInTheDocument();
  });

  it('hides "Next problem" in expanded (full) scope when the focal stage has no findings', () => {
    render(<PlanGraphCanvas model={model({ scope: 'full' })} showMiniMap={false} stageId={1} findings={[]} />);
    expect(screen.queryByRole('button', { name: /next problem/i })).not.toBeInTheDocument();
  });

  it('shows "Next problem" in expanded scope when the focal stage has findings, and it jumps to the stage box', async () => {
    const user = userEvent.setup();
    setCenterMock.mockClear();
    const findings = [{ type: 'skew', stageId: 1, impactBand: 'critical' as const }];
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

  it('orders "Next problem" by descending recoverable time, jumping to the biggest time win first', async () => {
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
    // Stage 8's finding recovers far more wall-clock time than stage 7's, so it
    // must be the first "Next problem" target regardless of node/list order.
    const findings = [
      { type: 'skew', stageId: 7, impactBand: 'warning' as const, impactEstimate: { basis: 'serial' as const, wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' as const } },
      { type: 'spill', stageId: 8, impactBand: 'warning' as const, impactEstimate: { basis: 'serial' as const, wallClock: { low: 90000, high: 90000 }, estimateMethod: 'measured' as const } },
    ];
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
  it('always renders a segment-level group container with its stage id and duration chip', () => {
    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 500 },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: null },
      ],
      edges: [],
      scope: 'full',
    });
    const segmentStageIds = new Map([[0, 42], [1, 43]]);

    render(<PlanGraphCanvas model={grouped} showMiniMap={false} stageId={42} segmentStageIds={segmentStageIds} />);

    const segment0 = within(screen.getByTestId('rf__node-segment-0'));
    const segment1 = within(screen.getByTestId('rf__node-segment-1'));
    expect(segment0.getByText(/stage 42/i)).toBeInTheDocument();
    expect(segment1.getByText(/stage 43/i)).toBeInTheDocument();
    expect(segment0.getByText(formatDuration(500))).toBeInTheDocument();
    expect(segment1.getByText('—')).toBeInTheDocument();
  });

  it('renders the outer stage-level group only in full scope, merging segments zipped to the same stage', () => {
    const single = model({ scope: 'segment' });
    const { rerender } = render(<PlanGraphCanvas model={single} showMiniMap={false} stageId={1} segmentStageIds={new Map([[0, 1]])} />);
    expect(screen.queryByTestId(/rf__node-stage-/)).not.toBeInTheDocument();

    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 500 },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: 300 },
        { id: 'c', sourceNodeId: 'c', label: 'Filter', category: 'filter', operatorDetail: '', primaryMetric: '', segmentIndex: 2, splitRole: null, durationShare: 200 },
      ],
      edges: [],
      scope: 'full',
    });
    const segmentStageIds = new Map([[0, 42], [1, 42], [2, 43]]);
    rerender(<PlanGraphCanvas model={grouped} showMiniMap={false} stageId={42} segmentStageIds={segmentStageIds} />);

    expect(screen.getAllByTestId(/rf__node-stage-/)).toHaveLength(2);
    expect(within(screen.getByTestId('rf__node-stage-42')).getByText('Stage 42')).toBeInTheDocument();
    expect(within(screen.getByTestId('rf__node-stage-43')).getByText('Stage 43')).toBeInTheDocument();
  });

  it('in single-stage (segment) scope, shows the focal stage\'s findings on the one segment box', () => {
    const single = model({ scope: 'segment', segmentStageIds: new Map([[0, 7]]) });
    const findings = [{ type: 'skew', stageId: 7, impactBand: 'critical' as const }];

    render(<PlanGraphCanvas model={single} showMiniMap={false} stageId={7} findings={findings} segmentStageIds={new Map([[0, 7]])} />);

    expect(screen.getByText('SKEW')).toBeInTheDocument();
  });

  it('opens the documentation sheet when a segment finding badge is clicked', async () => {
    const user = userEvent.setup();
    const single = model({ scope: 'segment', segmentStageIds: new Map([[0, 7]]) });
    const findings = [{ type: 'skew', stageId: 7, impactBand: 'critical' as const }];

    render(
      <ThemeProvider>
        <DocsProvider>
          <PlanGraphCanvas
            model={single}
            showMiniMap={false}
            stageId={7}
            findings={findings}
            segmentStageIds={new Map([[0, 7]])}
          />
          <DocsSheet />
        </DocsProvider>
      </ThemeProvider>,
    );

    await user.click(screen.getByRole('link', { name: 'SKEW' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const [base, hash] = docsUrl('#bottleneck-skew').split('#');
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(`${base}?t=dark#${hash}`);
  });

  it('keeps the focal segment box and its findings when foreground filtering hides every plan node', () => {
    const single = model({
      scope: 'segment',
      segmentStageIds: new Map([[0, 7]]),
    });
    const findings = [{ type: 'skew', stageId: 7, impactBand: 'critical' as const }];

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

    expect(screen.getByTestId('rf__node-segment-0')).toBeInTheDocument();
    expect(screen.getByText('SKEW')).toBeInTheDocument();
    expect(screen.queryByTestId('rf__node-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rf__node-b')).not.toBeInTheDocument();
  });

  it('in expanded (full) scope, shows findings inline in the matched segment box\'s header, not duplicated on the outer stage box', () => {
    const grouped = model({
      nodes: [
        { id: 'a', sourceNodeId: 'a', label: 'Scan parquet', category: 'scan', operatorDetail: '', primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: null },
        { id: 'b', sourceNodeId: 'b', label: 'SortMergeJoin', category: 'join', operatorDetail: '', primaryMetric: '', segmentIndex: 1, splitRole: null, durationShare: null },
      ],
      edges: [],
      scope: 'full',
    });
    const segmentStageIds = new Map([[0, 7], [1, 8]]);
    const findings = [{ type: 'skew', stageId: 7, impactBand: 'critical' as const }];

    render(<PlanGraphCanvas model={grouped} showMiniMap={false} stageId={7} findings={findings} segmentStageIds={segmentStageIds} />);

    // Exactly one "SKEW" chip on screen, and it's inside stage 7's segment box.
    expect(screen.getAllByText('SKEW')).toHaveLength(1);
    expect(within(screen.getByTestId('rf__node-segment-0')).getByText('SKEW')).toBeInTheDocument();
    expect(within(screen.getByTestId('rf__node-stage-7')).queryByText('SKEW')).not.toBeInTheDocument();
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
    const findings = [{ type: 'skew', stageId: 7, impactBand: 'critical' as const }];

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

    expect(within(screen.getByTestId('rf__node-segment-0')).getByText('SKEW')).toBeInTheDocument();
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
    const findings = [{ type: 'skew', stageId: 7, impactBand: 'critical' as const }];

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

describe('legend', () => {
  it('is open by default and collapses on click', async () => {
    const user = userEvent.setup();
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} />);
    // Open by default so the color heat key is visible without a hunt for it.
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

describe('all-nodes-hidden hint', () => {
  it('shows a status hint when the filter hides every operator', () => {
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} visibleNodeIds={new Set()} visibleEdges={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent(/hidden by the node filter/i);
  });

  it('shows no hint when some operators are visible', () => {
    render(<PlanGraphCanvas model={model()} showMiniMap={false} stageId={1} visibleNodeIds={new Set(['a'])} visibleEdges={[]} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
