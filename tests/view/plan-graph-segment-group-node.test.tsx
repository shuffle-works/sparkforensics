// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanGraphSegmentGroupNode } from '../../src/view/plan-graph/PlanGraphSegmentGroupNode';

function nodeProps(overrides = {}) {
  return {
    id: 'segment-0', selected: false, type: 'segmentGroup', dragging: false, zIndex: 1, isConnectable: false,
    selectable: true, deletable: true, draggable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { width: 300, height: 200, stageId: 12, durationLabel: '1.2s', sharesStage: false, ...overrides },
  };
}

describe('PlanGraphSegmentGroupNode', () => {
  describe('inside a stage box', () => {
    it('paints no header: the stage box names the stage', () => {
      render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
      expect(screen.queryByText(/stage/i)).not.toBeInTheDocument();
      expect(screen.queryByText('1.2s')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('has no stroke and no ring', () => {
      const { container } = render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
      expect(container.firstElementChild).not.toHaveClass('border');
      expect(container.firstElementChild).not.toHaveClass('ring-2');
    });

    it('is plain when the stage holds one segment, and a band when it holds several', () => {
      const { container, rerender } = render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
      expect(container.firstElementChild).not.toHaveClass('bg-primary/10');
      rerender(<PlanGraphSegmentGroupNode {...nodeProps({ sharesStage: true })} />);
      expect(container.firstElementChild).toHaveClass('bg-primary/10');
    });

    it('takes no clicks, so the stage box behind it stays the target', () => {
      const { container } = render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
      expect(container.firstElementChild).toHaveStyle({ pointerEvents: 'none' });
    });
  });

  describe('with no stage', () => {
    it('shows "Stage —" and its duration chip in a dashed box', () => {
      const { container } = render(<PlanGraphSegmentGroupNode {...nodeProps({ stageId: null })} />);
      expect(screen.getByText('Stage —')).toBeInTheDocument();
      expect(screen.getByText('1.2s')).toBeInTheDocument();
      expect(container.firstElementChild).toHaveClass('border-dashed');
    });

    it('shows an em-dash placeholder instead of a blank chip when there is no attributed duration', () => {
      render(<PlanGraphSegmentGroupNode {...nodeProps({ stageId: null, durationLabel: null })} />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('explains the "Stage —" placeholder with a tooltip', () => {
      render(<PlanGraphSegmentGroupNode {...nodeProps({ stageId: null })} />);
      expect(screen.getByText('Stage —')).toHaveAttribute(
        'title',
        "This plan segment couldn't be matched to a specific Spark stage",
      );
    });

    it('offers no stage entry point', () => {
      render(<PlanGraphSegmentGroupNode {...nodeProps({ stageId: null })} />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });
});
