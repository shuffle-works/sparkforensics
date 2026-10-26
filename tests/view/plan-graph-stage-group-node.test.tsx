// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphStageGroupNode } from '../../src/view/plan-graph/PlanGraphStageGroupNode';
import { StageSelectionProvider } from '../../src/view/plan-graph/stage-selection';

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

  describe('as a stage entry point', () => {
    const findings = [{ type: 'skew', stageId: 12, impactBand: 'critical' as const }];
    const renderSelectable = (overrides = {}, selectedStageId: number | null = null) => {
      const select = vi.fn();
      render(
        <StageSelectionProvider value={{ selectedStageId, select }}>
          <PlanGraphStageGroupNode {...nodeProps(overrides)} />
        </StageSelectionProvider>,
      );
      return select;
    };

    it('selects the stage with the corner title as the entry', async () => {
      const select = renderSelectable();
      const title = screen.getByRole('button', { name: 'Show the findings for stage 12' });
      await userEvent.click(title);
      expect(select).toHaveBeenCalledWith(12, title);
    });

    it('selects the stage from its own-findings chip', async () => {
      const select = renderSelectable({ findings });
      const chip = screen.getByRole('button', { name: 'SKEW' });
      await userEvent.click(chip);
      expect(select).toHaveBeenCalledWith(12, chip);
    });

    it('keeps "Focus stage" as the box click target', async () => {
      const onSelect = vi.fn();
      const select = renderSelectable({ onSelect });
      await userEvent.click(screen.getByRole('button', { name: 'Focus stage 12' }));
      expect(onSelect).toHaveBeenCalledOnce();
      expect(select).not.toHaveBeenCalled();
    });

    it('paints its own chips above the top edge, clear of the headers inside the box', () => {
      renderSelectable({ findings });
      const row = screen.getByRole('button', { name: 'SKEW' }).closest('div');
      expect(row).toHaveClass('bottom-full');
      expect(row).not.toHaveClass('top-1');
    });

    it('shows a ring only on the selected stage', () => {
      const { unmount } = render(<PlanGraphStageGroupNode {...nodeProps()} />);
      expect(screen.getByText('Stage 12').closest('.relative')).not.toHaveClass('ring-2');
      unmount();

      renderSelectable({}, 12);
      expect(screen.getByRole('button', { name: 'Focus stage 12' }).parentElement).toHaveClass('ring-2');
    });
  });
});
