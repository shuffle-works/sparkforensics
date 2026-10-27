// tests/view/join-key-cast.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { JoinKeyCast } from '@/view/widgets/JoinKeyCast';
import type { Finding } from '@sparkforensics/core/types.ts';

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'joinKeyCast',
    executionId: 1,
    stageIds: [5],
    impactBand: 'info',
    metric: 'shuffleBytes',
    value: 4096,
    nodeName: 'SortMergeJoin',
    castKeys: ['cast(k as decimal(20,0))'],
    exchangeKeys: ['k'],
    recommendation: 'SortMergeJoin joins on cast(k as decimal(20,0)).',
    ...overrides,
  } as unknown as Finding;
}

function renderWidget(catalog: Finding[]) {
  return render(
    <DocsProvider>
      <EvidenceAvailabilityProvider>
        <JoinKeyCast catalog={catalog} defaultCollapsed={false} />
      </EvidenceAvailabilityProvider>
    </DocsProvider>,
  );
}

test('renders nothing when no joinKeyCast finding is present', () => {
  const { container } = renderWidget([{ type: 'spill', stageId: 1, impactBand: 'warning' } as unknown as Finding]);
  expect(container.firstChild).toBeNull();
});

test('renders the PLAN card with each join, its recommendation and its stage pill', () => {
  renderWidget([
    finding({ stageIds: [5], recommendation: 'join rec A' }),
    finding({ stageIds: [6], recommendation: 'join rec B' }),
  ]);
  expect(screen.getByRole('heading', { name: 'Join Key Casts' })).toBeInTheDocument();
  expect(screen.getAllByText('PLAN').length).toBeGreaterThan(0);
  expect(screen.getByText(/join rec A/)).toBeInTheDocument();
  expect(screen.getByText(/join rec B/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 5' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 6' })).toBeInTheDocument();
});
