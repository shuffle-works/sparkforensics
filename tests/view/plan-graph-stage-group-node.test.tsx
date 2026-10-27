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
    data: { width: 400, height: 300, stageId: 12, findings: [], durationLabel: null, wrapsGraph: false, ...overrides },
  };
}

describe('PlanGraphStageGroupNode', () => {
  it('names the stage once', () => {
    render(<PlanGraphStageGroupNode {...nodeProps()} />);
    expect(screen.getAllByText('Stage 12')).toHaveLength(1);
  });

  it('shows the summed duration beside the name', () => {
    render(<PlanGraphStageGroupNode {...nodeProps({ durationLabel: '2.9s' })} />);
    expect(screen.getByText('2.9s')).toBeInTheDocument();
  });

  it('shows no duration chip when no segment has an attributed duration', () => {
    render(<PlanGraphStageGroupNode {...nodeProps()} />);
    expect(screen.queryByText('—')).not.toBeInTheDocument();
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

  it('shows the finding magnitude and recoverable time next to its tag', () => {
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

  it('has no box click target when onSelect is not provided', () => {
    render(<PlanGraphStageGroupNode {...nodeProps()} />);
    expect(screen.queryByRole('button', { name: /focus stage 12/i })).not.toBeInTheDocument();
    expect(screen.getByText('Stage 12')).toBeInTheDocument();
  });

  describe('header placement', () => {
    const findings = [{ type: 'skew', stageId: 12, impactBand: 'critical' as const }];

    it('sits inside the top edge when a segment is inside the box', () => {
      render(<PlanGraphStageGroupNode {...nodeProps({ findings })} />);
      const header = screen.getByText('Stage 12').closest('div');
      expect(header).toHaveClass('top-2');
      expect(header).not.toHaveClass('bottom-full');
    });

    it('sits above the top edge when the box wraps the whole graph, clear of the headers inside it', () => {
      render(<PlanGraphStageGroupNode {...nodeProps({ findings, wrapsGraph: true })} />);
      const header = screen.getByText('Stage 12').closest('div');
      expect(header).toHaveClass('bottom-full');
      expect(header).not.toHaveClass('top-2');
    });

    it('lets clicks past the empty part of the header to the box behind it', () => {
      render(<PlanGraphStageGroupNode {...nodeProps({ findings })} />);
      expect(screen.getByText('Stage 12').closest('div')).toHaveClass('pointer-events-none', '[&>*]:pointer-events-auto');
    });
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

    it('selects the stage with the title as the entry', async () => {
      const select = renderSelectable();
      const title = screen.getByRole('button', { name: 'Show the findings for stage 12' });
      await userEvent.click(title);
      expect(select).toHaveBeenCalledWith(12, title);
    });

    it('selects the stage from its chip', async () => {
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

    it('shows a ring only on the selected stage', () => {
      const { container, unmount } = render(<PlanGraphStageGroupNode {...nodeProps()} />);
      expect(container.firstElementChild).not.toHaveClass('ring-2');
      unmount();

      const { container: selected } = render(
        <StageSelectionProvider value={{ selectedStageId: 12, select: vi.fn() }}>
          <PlanGraphStageGroupNode {...nodeProps()} />
        </StageSelectionProvider>,
      );
      expect(selected.firstElementChild).toHaveClass('ring-2');
    });
  });
});
