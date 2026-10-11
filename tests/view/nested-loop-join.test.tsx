// tests/view/nested-loop-join.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { NestedLoopJoin } from '@/view/widgets/NestedLoopJoin';
import type { Finding } from '@sparkforensics/core/types.ts';

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'nestedLoopJoin',
    executionId: 1,
    stageIds: [5],
    impactBand: 'critical',
    metric: 'outputRows',
    value: 4498500,
    nodeName: 'BroadcastNestedLoopJoin',
    condition: '(a < b)',
    recommendation: 'BroadcastNestedLoopJoin on (a < b) produced 4,498,500 rows.',
    impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'modeled' },
    ...overrides,
  } as unknown as Finding;
}

function renderWidget(catalog: Finding[]) {
  return render(
    <DocsProvider>
      <EvidenceAvailabilityProvider>
        <NestedLoopJoin catalog={catalog} defaultCollapsed={false} />
      </EvidenceAvailabilityProvider>
    </DocsProvider>,
  );
}

test('renders nothing when no nestedLoopJoin finding is present', () => {
  const { container } = renderWidget([{ type: 'spill', stageId: 1, impactBand: 'warning' } as unknown as Finding]);
  expect(container.firstChild).toBeNull();
});

test('renders the PLAN card with each join, its recommendation and its stage pill', () => {
  renderWidget([
    finding({ stageIds: [5], recommendation: 'join rec A' }),
    finding({ stageIds: [6], recommendation: 'join rec B' }),
  ]);
  expect(screen.getByRole('heading', { name: 'Nested Loop Joins' })).toBeInTheDocument();
  expect(screen.getAllByText('PLAN').length).toBeGreaterThan(0);
  expect(screen.getByText(/join rec A/)).toBeInTheDocument();
  expect(screen.getByText(/join rec B/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 5' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 6' })).toBeInTheDocument();
});
