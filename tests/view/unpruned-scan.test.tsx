// tests/view/unpruned-scan.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { store } from '@/store/store';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { UnprunedScan } from '@/view/widgets/UnprunedScan';
import type { Finding } from '@sparkforensics/core/types.ts';
import { installInterpretation } from './_shared/interpretation';

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'unprunedScan',
    executionId: 1,
    stageIds: [5],
    impactBand: 'info',
    metric: 'bytesRead',
    value: 4 * 1024 ** 3,
    partitionsRead: 20,
    dataFilters: ['(status = ACTIVE)'],
    relation: 'db.events',
    confidence: 'low',
    validationRequired: 'Check whether any filter column is a partition column.',
    recommendation: 'Filter on the table partition columns.',
    ...overrides,
  } as unknown as Finding;
}

function renderWidget(catalog: Finding[]) {
  installInterpretation(catalog);
  return render(
    <DocsProvider>
      <EvidenceAvailabilityProvider>
        <UnprunedScan catalog={catalog} defaultCollapsed={false} />
      </EvidenceAvailabilityProvider>
    </DocsProvider>,
  );
}

test('renders nothing when no unprunedScan finding is present', () => {
  const { container } = renderWidget([{ type: 'spill', stageId: 1, impactBand: 'warning' } as unknown as Finding]);
  expect(container.firstChild).toBeNull();
});

test('renders the card with the PLAN tag and the low-confidence caveat', () => {
  store.getState().setWidgetDensity('advanced');
  renderWidget([finding()]);
  expect(screen.getByRole('heading', { name: 'Unpruned Partitioned Scan' })).toBeInTheDocument();
  expect(screen.getAllByText('PLAN').length).toBeGreaterThan(0);
  store.getState().setWidgetDensity('basic');
  cleanup();
});

test('names the table, bytes, partitions and filters of each scan', () => {
  renderWidget([finding(), finding({ relation: 'db.other', stageIds: [6], value: 2 * 1024 ** 3, dataFilters: ['(k = 3)'] })]);
  expect(screen.getByText('db.events')).toBeInTheDocument();
  expect(screen.getByText(/read 4\.3 GB from 20 partitions, filtered on \(status = ACTIVE\)/)).toBeInTheDocument();
  expect(screen.getByText('db.other')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 6' })).toBeInTheDocument();
});
