// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanGraphSegmentGroupNode } from '../../src/view/plan-graph/PlanGraphSegmentGroupNode';

function nodeProps(overrides = {}) {
  return {
    id: 'segment-0', selected: false, type: 'segmentGroup', dragging: false, zIndex: 1, isConnectable: false,
    selectable: true, deletable: true, draggable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { width: 300, height: 200, nearestStageId: 5, durationLabel: null, ...overrides },
  };
}

describe('PlanGraphSegmentGroupNode', () => {
  it('is a dashed box titled "Stage —" that names the nearest stage', () => {
    const { container } = render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
    expect(screen.getByText('Stage —')).toBeInTheDocument();
    expect(screen.getByText('nearest: Stage 5')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('border-dashed');
  });

  it('names no stage when the plan pairs no segment with a stage', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps({ nearestStageId: null })} />);
    expect(screen.getByText('Stage —')).toBeInTheDocument();
    expect(screen.queryByText(/nearest/)).not.toBeInTheDocument();
  });

  it('shows an em-dash placeholder instead of a blank chip when there is no attributed duration', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows its own duration when it has one', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps({ durationLabel: '1.2s' })} />);
    expect(screen.getByText('1.2s')).toBeInTheDocument();
  });

  it('explains both labels with a tooltip', () => {
    render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
    expect(screen.getByText('Stage —')).toHaveAttribute('title', 'This plan segment has no Spark stage of its own in the log');
    expect(screen.getByText('nearest: Stage 5')).toHaveAttribute('title', 'The closest stage the log pairs with a plan segment');
  });

  it('offers no stage entry point and takes no selection', () => {
    const { container } = render(<PlanGraphSegmentGroupNode {...nodeProps()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass('ring-2');
  });
});
