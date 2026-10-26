// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphSegmentGroupNode } from '../../src/view/plan-graph/PlanGraphSegmentGroupNode';
import { StageSelectionProvider } from '../../src/view/plan-graph/stage-selection';

function nodeProps(overrides = {}) {
  return {
    id: 'segment-0', selected: false, type: 'segmentGroup', dragging: false, zIndex: -1, isConnectable: false,
    selectable: true, deletable: true, draggable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { width: 300, height: 200, stageId: 12, durationLabel: '1.2s', findings: [], ...overrides },
  };
}

describe('PlanGraphSegmentGroupNode', () => {
  it('shows the stage id and duration chip in the header', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
    expect(screen.getByText(/stage 12/i)).toBeInTheDocument();
    expect(screen.getByText('1.2s')).toBeInTheDocument();
  });

  it('shows an em-dash placeholder instead of a blank chip when there is no attributed duration', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps({ durationLabel: null })} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows "Stage —" when the segment never won a stage-zip slot', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps({ stageId: null })} />);
    expect(screen.getByText('Stage —')).toBeInTheDocument();
  });

  it('explains the "Stage —" placeholder with a tooltip', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps({ stageId: null })} />);
    expect(screen.getByText('Stage —')).toHaveAttribute(
      'title',
      "This plan segment couldn't be matched to a specific Spark stage",
    );
  });

  it('has no explanatory tooltip when the segment has a real stage id', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
    expect(screen.getByText(/stage 12/i)).not.toHaveAttribute('title');
  });

  it('shows one tag chip per finding on this stage, not just the worst', () => {
    const findings = [
      { type: 'skew', stageId: 12, impactBand: 'critical' as const },
      { type: 'spill', stageId: 12, impactBand: 'warning' as const },
    ];
    render(<PlanGraphSegmentGroupNode {...nodeProps({ findings })} />);
    expect(screen.getByText('SKEW')).toBeInTheDocument();
    expect(screen.getByText('SPILL')).toBeInTheDocument();
  });

  it('shows no tag chips when this stage has no findings', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
    expect(screen.queryByText('SKEW')).not.toBeInTheDocument();
  });

  it('shows the finding magnitude and recoverable time next to the tag', () => {
    const findings = [
      { type: 'spill', stageId: 12, impactBand: 'warning' as const, metric: 'memoryBytesSpilled', value: 4.2e9, impactEstimate: { wallClock: { low: 30000, high: 38000 } } },
    ];
    render(<PlanGraphSegmentGroupNode {...nodeProps({ findings })} />);
    expect(screen.getByText('SPILL')).toBeInTheDocument();
    expect(screen.getByText('4.2 GB · ~38.0s')).toBeInTheDocument();
  });

  it('shows only the tag when a finding carries no formattable magnitude or time', () => {
    const findings = [
      { type: 'stageFailed', stageId: 12, impactBand: 'critical' as const, metric: 'stageFailureReason', value: 'ExecutorLostFailure' },
    ];
    render(<PlanGraphSegmentGroupNode {...nodeProps({ findings })} />);
    expect(screen.getByText('SFAIL')).toBeInTheDocument();
    expect(screen.queryByText('·')).not.toBeInTheDocument();
  });

  describe('as a stage entry point', () => {
    const findings = [
      { type: 'skew', stageId: 12, impactBand: 'critical' as const },
      { type: 'spill', stageId: 12, impactBand: 'warning' as const },
    ];
    const renderSelectable = (selectedStageId: number | null = null) => {
      const select = vi.fn();
      render(
        <StageSelectionProvider value={{ selectedStageId, select }}>
          <PlanGraphSegmentGroupNode {...nodeProps({ findings })} />
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

    it('selects the stage from any of its chips', async () => {
      const select = renderSelectable();
      const chip = screen.getByRole('button', { name: 'SPILL' });
      await userEvent.click(chip);
      expect(select).toHaveBeenCalledWith(12, chip);
    });

    it('gives the title and each chip the comfortable hit area', () => {
      renderSelectable();
      for (const name of ['Show the findings for stage 12', 'SKEW', 'SPILL']) {
        expect(screen.getByRole('button', { name })).toHaveClass('tap-target-comfortable');
      }
    });

    it('shows a ring only on the selected stage', () => {
      const { unmount } = render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
      expect(screen.getByText('Stage 12').closest('.border-dashed')).not.toHaveClass('ring-2');
      unmount();

      renderSelectable(12);
      expect(screen.getByRole('button', { name: 'Show the findings for stage 12' }).closest('.border-dashed')).toHaveClass('ring-2');
    });

    it('keeps the unmatched-segment title inert', () => {
      render(
        <StageSelectionProvider value={{ selectedStageId: null, select: vi.fn() }}>
          <PlanGraphSegmentGroupNode {...nodeProps({ stageId: null })} />
        </StageSelectionProvider>,
      );
      expect(screen.queryByRole('button', { name: /show the findings/i })).not.toBeInTheDocument();
    });

    it('renders plain text where no panel can open', () => {
      render(<PlanGraphSegmentGroupNode {...nodeProps({ findings })} />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByText('SKEW')).toBeInTheDocument();
    });
  });
});
