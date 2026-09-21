// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphNodeDetail, type PlanGraphNodeDetailData } from '@/view/plan-graph/PlanGraphNodeDetail';
import type { Finding } from '@sparkforensics/core/types.ts';

function node(overrides: Partial<PlanGraphNodeDetailData> = {}): PlanGraphNodeDetailData {
  return {
    id: 'n1', sourceNodeId: 'n1', label: 'SortMergeJoin', category: 'join',
    operatorDetail: 'Inner', primaryMetric: '1.2M rows',
    segmentIndex: 0, splitRole: null, durationShare: 500, durationSharePct: 37,
    findings: [],
    metrics: [
      { name: 'number of output rows', value: '1,200,000' },
      { name: 'peak memory', value: '256.0 MB' },
    ],
    detailText: 'SortMergeJoin [customer_id#12], [order_id#44], Inner',
    ...overrides,
  };
}

const finding = (): Finding =>
  ({ id: 'f1', type: 'duplicatePlanSubtree', impactBand: 'warning', stageId: 1 } as unknown as Finding);

describe('PlanGraphNodeDetail', () => {
  it('shows the label, category, segment, and duration share', () => {
    render(<PlanGraphNodeDetail node={node()} onClose={vi.fn()} />);
    expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
    expect(screen.getByText(/Join · Segment 1/)).toBeInTheDocument();
    expect(screen.getByText('37%')).toBeInTheDocument();
  });

  it('lists every metric with its formatted value', () => {
    render(<PlanGraphNodeDetail node={node()} onClose={vi.fn()} />);
    const metrics = within(screen.getByText('Metrics').closest('div')!);
    expect(metrics.getByText('number of output rows')).toBeInTheDocument();
    expect(metrics.getByText('1,200,000')).toBeInTheDocument();
    expect(metrics.getByText('peak memory')).toBeInTheDocument();
    expect(metrics.getByText('256.0 MB')).toBeInTheDocument();
  });

  it('shows the full untruncated plan detail text', () => {
    render(<PlanGraphNodeDetail node={node()} onClose={vi.fn()} />);
    expect(screen.getByTestId('plan-node-detail-text')).toHaveTextContent(
      'SortMergeJoin [customer_id#12], [order_id#44], Inner',
    );
  });

  it('lists each finding by its tag and action label', () => {
    render(<PlanGraphNodeDetail node={node({ findings: [finding()] })} onClose={vi.fn()} />);
    expect(screen.getByText('PLAN')).toBeInTheDocument();
    expect(screen.getByText(/dedupe/i)).toBeInTheDocument();
  });

  it('renders each finding tag as a docs link, like the dashboard pills', () => {
    render(<PlanGraphNodeDetail node={node({ findings: [finding()] })} onClose={vi.fn()} />);
    // TagBadge links the pill into the docs panel; outside a DocsProvider it
    // still carries a real href fallback.
    const link = screen.getByText('PLAN').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href');
  });

  it('explains which half of a split Exchange is in view', () => {
    render(<PlanGraphNodeDetail node={node({ splitRole: 'read', label: 'Exchange' })} onClose={vi.fn()} />);
    expect(screen.getByText(/read half/i)).toBeInTheDocument();
  });

  it('shows the shuffle volume crossing the Exchange boundary', () => {
    render(
      <PlanGraphNodeDetail
        node={node({ splitRole: 'write', label: 'Exchange', exchangeShuffleBytes: 1_500_000_000 })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/shuffle written/i)).toBeInTheDocument();
    expect(screen.getByText('1.5 GB')).toBeInTheDocument();
  });

  it('labels a broadcast exchange as carrying no shuffle', () => {
    render(
      <PlanGraphNodeDetail
        node={node({ splitRole: 'read', label: 'BroadcastExchange', exchangeShuffleBytes: null })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/broadcast, no shuffle/i)).toBeInTheDocument();
  });

  it('offers a jump to the paired half, named for the opposite half, and fires onJumpToPaired with its id', async () => {
    const onJumpToPaired = vi.fn();
    render(
      <PlanGraphNodeDetail
        node={node({ splitRole: 'read', label: 'Exchange', pairedNodeId: 'n7' })}
        onClose={vi.fn()}
        onJumpToPaired={onJumpToPaired}
      />,
    );
    const button = screen.getByRole('button', { name: /jump to write half/i });
    await userEvent.click(button);
    expect(onJumpToPaired).toHaveBeenCalledWith('n7');
  });

  it('omits the jump button when the node has no paired half', () => {
    render(
      <PlanGraphNodeDetail
        node={node({ splitRole: 'write', label: 'Exchange', pairedNodeId: null })}
        onClose={vi.fn()}
        onJumpToPaired={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /jump to/i })).not.toBeInTheDocument();
  });

  it('fires onClose from the close button', async () => {
    const onClose = vi.fn();
    render(<PlanGraphNodeDetail node={node()} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /close node detail/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits sections that have no data', () => {
    render(
      <PlanGraphNodeDetail
        node={node({ metrics: [], detailText: '', durationSharePct: null, findings: [] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Metrics')).not.toBeInTheDocument();
    expect(screen.queryByText('Plan detail')).not.toBeInTheDocument();
    expect(screen.queryByText('Findings')).not.toBeInTheDocument();
    expect(screen.queryByText(/of plan stage time/)).not.toBeInTheDocument();
  });
});
