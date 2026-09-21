// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphStageGroupNode } from '../../src/view/plan-graph/PlanGraphStageGroupNode';

function nodeProps(overrides = {}) {
  return {
    id: 'stage-12', selected: false, type: 'stageGroup', dragging: false, zIndex: -2, isConnectable: false,
    selectable: true, deletable: true, draggable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { width: 400, height: 300, stageId: 12, findings: [], ...overrides },
  };
}

describe('PlanGraphStageGroupNode', () => {
  it('shows the stage id in the corner', () => {
    render(<PlanGraphStageGroupNode {...nodeProps()} />);
    expect(screen.getByText('Stage 12')).toBeInTheDocument();
  });

  it('shows one tag chip per finding on this stage', () => {
    const findings = [
      { type: 'skew', stageId: 12, impactBand: 'critical' as const },
      { type: 'spill', stageId: 12, impactBand: 'warning' as const },
    ];
    render(<PlanGraphStageGroupNode {...nodeProps({ findings })} />);
    expect(screen.getByText('SKEW')).toBeInTheDocument();
    expect(screen.getByText('SPILL')).toBeInTheDocument();
  });

  it('shows no tag chips when this stage has no findings', () => {
    render(<PlanGraphStageGroupNode {...nodeProps()} />);
    expect(screen.queryByText('SKEW')).not.toBeInTheDocument();
  });

  it('shows the finding magnitude and recoverable time next to its own-findings tag', () => {
    const findings = [
      { type: 'spill', stageId: 12, impactBand: 'warning' as const, metric: 'memoryBytesSpilled', value: 4.2e9, impactEstimate: { wallClock: { low: 30000, high: 38000 } } },
    ];
    render(<PlanGraphStageGroupNode {...nodeProps({ findings })} />);
    expect(screen.getByText('SPILL')).toBeInTheDocument();
    expect(screen.getByText('4.2 GB · ~38.0s')).toBeInTheDocument();
  });

  it('calls data.onSelect when the box is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<PlanGraphStageGroupNode {...nodeProps({ onSelect })} />);
    await user.click(screen.getByRole('button', { name: /focus stage 12/i }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('renders the clickable box even when onSelect is not provided (no crash)', async () => {
    const user = userEvent.setup();
    render(<PlanGraphStageGroupNode {...nodeProps()} />);
    await user.click(screen.getByRole('button', { name: /focus stage 12/i }));
    expect(screen.getByText('Stage 12')).toBeInTheDocument();
  });
});
