// tests/view/merge-rewrite.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { MergeRewrite } from '@/view/widgets/MergeRewrite';
import type { Finding } from '@sparkforensics/core/types.ts';

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'mergeRewrite',
    executionId: 1,
    stageIds: [5],
    impactBand: 'info',
    rule: 'rewrittenRows',
    metric: 'rewrittenRows',
    value: 800000,
    rewrittenRows: 800000,
    changedRows: 300000,
    filesBefore: 8,
    filesAfter: 8,
    partitionsScanned: 4,
    partitionsTouched: 4,
    recommendation: 'MERGE rewrote 800,000 unmodified target rows to change 300,000.',
    ...overrides,
  } as unknown as Finding;
}

function renderWidget(catalog: Finding[]) {
  return render(
    <DocsProvider>
      <EvidenceAvailabilityProvider>
        <MergeRewrite catalog={catalog} defaultCollapsed={false} />
      </EvidenceAvailabilityProvider>
    </DocsProvider>,
  );
}

test('renders nothing when no mergeRewrite finding is present', () => {
  const { container } = renderWidget([{ type: 'spill', stageId: 1, impactBand: 'warning' } as unknown as Finding]);
  expect(container.firstChild).toBeNull();
});

test('renders the PLAN card with each MERGE finding and its stage pill', () => {
  renderWidget([
    finding({ recommendation: 'merge rec A' }),
    finding({ rule: 'weakSkipping', stageIds: [6], recommendation: 'merge rec B' }),
  ]);
  expect(screen.getByRole('heading', { name: 'MERGE rewrites' })).toBeInTheDocument();
  expect(screen.getAllByText('PLAN').length).toBeGreaterThan(0);
  expect(screen.getByText(/merge rec A/)).toBeInTheDocument();
  expect(screen.getByText(/merge rec B/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 5' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 6' })).toBeInTheDocument();
});
