// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { PlanGraphNode } from '../../src/view/plan-graph/PlanGraphNode';
import type { PlanGraphNodeData } from '@sparkforensics/core/types.ts';

function nodeData(overrides: Partial<PlanGraphNodeData & { durationSharePct: number | null }> = {}) {
  return {
    id: 'n1', sourceNodeId: 'n1', label: 'SortMergeJoin', category: 'join', operatorDetail: 'Inner',
    primaryMetric: '1.2M rows', segmentIndex: 0, splitRole: null, durationShare: null,
    durationSharePct: null, findings: [],
    ...overrides,
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

// Base `NodeProps` the installed @xyflow/react version requires of a custom
// node, minus `id`/`data` (supplied per call).
const BASE_NODE_PROPS = {
  selected: false, type: 'planNode', dragging: false, zIndex: 0, isConnectable: true,
  selectable: true, deletable: true, draggable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
} as const;

describe('PlanGraphNode', () => {
  it('renders the label, operator detail, and primary metric', () => {
    render(<PlanGraphNode data={nodeData()} id="n1" {...BASE_NODE_PROPS} />, { wrapper: Wrapper });
    expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
    expect(screen.getByText('Inner')).toBeInTheDocument();
    expect(screen.getByText('1.2M rows')).toBeInTheDocument();
  });

  it('shows the duration-share percentage as text on the heat bar', () => {
    render(<PlanGraphNode data={nodeData({ durationSharePct: 42 })} id="n1" {...BASE_NODE_PROPS} />, { wrapper: Wrapper });
    // Visible non-color cue: the plain "42%" span next to the bar.
    expect(screen.getByText('42%')).toBeInTheDocument();
    // Plus an sr-only band description so a screen reader gets the magnitude too.
    expect(screen.getByText(/Duration share 42%, high/i)).toBeInTheDocument();
  });

  it('sizes the heat bar fill to the duration-share percentage', () => {
    const { rerender } = render(<PlanGraphNode data={nodeData({ durationSharePct: 25 })} id="n1" {...BASE_NODE_PROPS} />, { wrapper: Wrapper });
    expect(screen.getByTestId('duration-heat-bar-fill')).toHaveStyle({ width: '25%' });

    rerender(<PlanGraphNode data={nodeData({ durationSharePct: 75 })} id="n1" {...BASE_NODE_PROPS} />);
    expect(screen.getByTestId('duration-heat-bar-fill')).toHaveStyle({ width: '75%' });
  });

  it('shows a "paired" indicator instead of a heat bar/alert badge for a read-half split node', () => {
    render(
      <PlanGraphNode
        data={nodeData({ splitRole: 'read', durationSharePct: null, label: 'Exchange hashpartitioning' })}
        id="n1-read" {...BASE_NODE_PROPS}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/paired/i)).toBeInTheDocument();
    expect(screen.queryByText('SHFL')).not.toBeInTheDocument();
  });

  it('still shows the heat bar for a read-half split node when it carries a real duration share', () => {
    // The even-split duration fallback (plan-duration-attribution.ts) can
    // legitimately attribute a nonzero share of the consuming stage's wall
    // time to a read half; hiding it unconditionally would throw that away.
    render(
      <PlanGraphNode
        data={nodeData({ splitRole: 'read', durationSharePct: 42, label: 'Exchange hashpartitioning' })}
        id="n1-read" {...BASE_NODE_PROPS}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/paired/i)).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByTestId('duration-heat-bar-fill')).toBeInTheDocument();
  });

  it('renders no badge when there are no findings', () => {
    render(<PlanGraphNode data={nodeData()} id="n1" {...BASE_NODE_PROPS} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('node-finding-badge')).not.toBeInTheDocument();
  });

  it('renders the tag (no count) for a single finding, colored by its band', () => {
    render(
      <PlanGraphNode data={nodeData({ findings: [{ type: 'smallFiles', impactBand: 'warning' }] })} id="n1" {...BASE_NODE_PROPS} />,
      { wrapper: Wrapper },
    );
    const badge = screen.getByTestId('node-finding-badge');
    expect(badge).toHaveTextContent('PLAN');
    expect(badge).toHaveClass('text-warning');
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });

  it('renders a count and colors the badge by the worst band when more than one finding hits the node', () => {
    render(
      <PlanGraphNode
        data={nodeData({ findings: [{ type: 'smallFiles', impactBand: 'warning' }, { type: 'overBroadcast', impactBand: 'critical' }] })}
        id="n1" {...BASE_NODE_PROPS}
      />,
      { wrapper: Wrapper },
    );
    const badge = screen.getByTestId('node-finding-badge');
    expect(badge).toHaveTextContent('2');
    // Worst band (critical) drives the color, not the first finding's (warning).
    expect(badge).toHaveClass('text-critical');
  });

  it('lists each finding by its action label in a hover tooltip', async () => {
    const user = userEvent.setup();
    render(
      <PlanGraphNode
        data={nodeData({ findings: [{ type: 'smallFiles', impactBand: 'warning' }, { type: 'overBroadcast', impactBand: 'critical' }] })}
        id="n1" {...BASE_NODE_PROPS}
      />,
      { wrapper: Wrapper },
    );
    await user.hover(screen.getByTestId('node-finding-badge'));
    // These action labels only ever appear inside the badge's tooltip, so
    // finding them at all confirms the tooltip opened and listed each finding.
    expect(await screen.findByText(/compact small files/i)).toBeInTheDocument();
    expect(await screen.findByText(/fix oversized broadcast/i)).toBeInTheDocument();
  });

  it('colors the heat bar critical at or above the critical threshold', () => {
    render(<PlanGraphNode data={nodeData({ durationSharePct: 40 })} id="n1" {...BASE_NODE_PROPS} />, { wrapper: Wrapper });
    expect(screen.getByTestId('duration-heat-bar-fill')).toHaveClass('bg-critical');
  });

  it('colors the heat bar info below the warn threshold', () => {
    render(<PlanGraphNode data={nodeData({ durationSharePct: 5 })} id="n1" {...BASE_NODE_PROPS} />, { wrapper: Wrapper });
    expect(screen.getByTestId('duration-heat-bar-fill')).toHaveClass('bg-info');
  });
});
