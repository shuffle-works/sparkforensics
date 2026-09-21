// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { emptyAppModel } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { IncompleteRun } from '@/view/widgets/IncompleteRun';
import type { Finding } from '@sparkforensics/core/types.ts';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'incompleteRun', stageId: null, impactBand: 'warning',
    metric: 'applicationEnd', value: 'missing',
    recommendation: 'Findings and metrics elsewhere on this board reflect only what was captured before the run was cut off.',
    ...overrides,
  };
}

function renderWidget(catalog: Finding[]) {
  return render(
    <DocsProvider>
      <IncompleteRun appModel={emptyAppModel()} catalog={catalog} getTaskData={() => Promise.reject()} />
    </DocsProvider>,
  );
}

test('renders nothing when no incompleteRun finding is present', () => {
  const other: Finding = { type: 'spill', stageId: 1, impactBand: 'warning' };
  const { container } = renderWidget([other]);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading and INCMP tag badge with the finding impact band', () => {
  renderWidget([finding({ impactBand: 'critical' })]);
  expect(screen.getByRole('heading', { name: 'Incomplete Run' })).toBeInTheDocument();
  expect(screen.getByText('INCMP')).toBeInTheDocument();
});

test('shows the recommendation text and no doc link (this detector sets no docAnchor)', async () => {
  const user = await import('@testing-library/user-event').then((m) => m.default.setup());
  renderWidget([finding()]);

  // The card starts collapsed (defaultCollapsed=true), so expand it first
  const cardDisclosure = screen.getByRole('button', { name: 'Incomplete Run' });
  await user.click(cardDisclosure);

  // Explanatory text and recommendation are both shown unconditionally now
  // (the old per-row toggle that used to hide the recommendation is gone).
  expect(
    screen.getByText(/this run.s event log never recorded an applicationend event/i),
  ).toBeInTheDocument();
  expect(screen.getByText(/reflect only what was captured before the run was cut off/i)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /learn more/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /show incomplete run/i })).not.toBeInTheDocument();
});

test('renders no impact-estimate element for its informational-only finding', async () => {
  renderWidget([finding({
    impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' },
  })]);

  expect(screen.queryByText(/Est\./)).not.toBeInTheDocument();
  expect(document.querySelector('.impact-estimate')).not.toBeInTheDocument();
});

test('renders no domain-specific copy', () => {
  const { container } = renderWidget([finding()]);
  expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
});
