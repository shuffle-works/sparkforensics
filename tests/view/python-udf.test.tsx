// tests/view/python-udf.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { PythonUdf } from '@/view/widgets/PythonUdf';
import type { Finding } from '@sparkforensics/core/types.ts';

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'pythonUdf',
    executionId: 1,
    stageIds: [5],
    impactBand: 'info',
    metric: 'dataSentBytes',
    value: 210_000_000,
    recommendation: 'Row-at-a-time Python UDFs (BatchEvalPython) sent 210 MB to Python workers over 1m 0s of stage time.',
    ...overrides,
  } as unknown as Finding;
}

function renderWidget(catalog: Finding[]) {
  return render(
    <DocsProvider>
      <EvidenceAvailabilityProvider>
        <PythonUdf catalog={catalog} defaultCollapsed={false} />
      </EvidenceAvailabilityProvider>
    </DocsProvider>,
  );
}

test('renders nothing when no pythonUdf finding is present', () => {
  const { container } = renderWidget([{ type: 'spill', stageId: 1, impactBand: 'warning' } as unknown as Finding]);
  expect(container.firstChild).toBeNull();
  cleanup();
});

test('renders the card with the PLAN tag, the recommendation and the stage pill', () => {
  renderWidget([finding()]);
  expect(screen.getByRole('heading', { name: 'Row-at-a-time Python UDFs' })).toBeInTheDocument();
  expect(screen.getAllByText('PLAN').length).toBeGreaterThan(0);
  expect(screen.getByText(/sent 210 MB to Python workers over 1m 0s of stage time/)).toBeInTheDocument();
  cleanup();
});
