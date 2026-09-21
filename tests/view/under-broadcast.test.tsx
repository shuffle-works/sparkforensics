// tests/view/under-broadcast.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { store } from '@/store/store';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { UnderBroadcast } from '@/view/widgets/UnderBroadcast';
import { expectImpactThenStageOrderByText } from './_shared/sort-order-toggle';
import type { Finding } from '@sparkforensics/core/types.ts';

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'underBroadcast',
    executionId: 1,
    stageIds: [5, 6],
    impactBand: 'warning',
    metric: 'estimatedBuildSideBytes',
    value: 10 * 1024 * 1024,
    recommendation: 'Raise spark.sql.autoBroadcastJoinThreshold or add a broadcast hint.',
    ...overrides,
  } as unknown as Finding;
}

function renderWidget(catalog: Finding[], { defaultCollapsed = false }: { defaultCollapsed?: boolean } = {}) {
  return render(
    <DocsProvider>
      <EvidenceAvailabilityProvider>
        <UnderBroadcast catalog={catalog} defaultCollapsed={defaultCollapsed} />
      </EvidenceAvailabilityProvider>
    </DocsProvider>,
  );
}

test('renders nothing when no underBroadcast finding is present', () => {
  const { container } = renderWidget([{ type: 'spill', stageId: 1, impactBand: 'warning' }]);
  expect(container.firstChild).toBeNull();
});

test('renders a WidgetCard heading with the PLAN tag', async () => {
  store.getState().setWidgetDensity('advanced');
  renderWidget([finding()]);
  expect(screen.getByRole('heading', { name: 'Missed Broadcast Join' })).toBeInTheDocument();
  expect(screen.getAllByText('PLAN').length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: /^evidence: sql plan$/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('flags every finding, each with its own recommendation and stage pills', () => {
  renderWidget([
    finding({ stageIds: [1], recommendation: 'under rec A' }),
    finding({ stageIds: [2], recommendation: 'under rec B' }),
  ]);
  expect(screen.getByText(/under rec A/)).toBeInTheDocument();
  expect(screen.getByText(/under rec B/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 1' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 2' })).toBeInTheDocument();
});

test('tags the PLAN badge with the dedicated plan-violet category, keeping the impact dot', () => {
  renderWidget([finding({ impactBand: 'warning' })]);
  const badges = screen.getAllByText('PLAN');
  expect(badges.length).toBeGreaterThan(0);
  for (const badge of badges) {
    expect(badge.className).toContain('text-plan-aggregate');
    expect(badge.className).toContain('bg-plan-aggregate/8');
    const dot = badge.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toMatch(/bg-(critical|warning|info)/);
  }
});

test('shows a confidence marker when the finding carries one', () => {
  store.getState().setWidgetDensity('advanced');
  renderWidget([finding({ confidence: 'medium', validationRequired: 'verify me' })]);
  expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('takes the worst impact band for the widget accent', () => {
  const { container } = renderWidget([
    finding({ impactBand: 'info' }),
    finding({ impactBand: 'critical' }),
  ]);
  expect(container.querySelector('.border-critical')).not.toBeNull();
});

test('defaults to impact order (highest potential savings first), and a toggle flips it back at advanced density', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget([
    finding({ stageIds: [1], recommendation: 'Broadcast stage 1', impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } }),
    finding({ stageIds: [2], recommendation: 'Broadcast stage 2', impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } }),
  ]);

  const listItems = () => screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
  await expectImpactThenStageOrderByText(user, listItems, /Broadcast stage 1/, /Broadcast stage 2/);
  store.getState().setWidgetDensity('basic');
});

test('hides the sort toggle at basic density', () => {
  renderWidget([
    finding({ stageIds: [1], recommendation: 'Broadcast stage 1', impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } }),
    finding({ stageIds: [2], recommendation: 'Broadcast stage 2', impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } }),
  ]);
  expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
});

test('paginates 6-at-a-time with Previous/Next controls', async () => {
  const user = userEvent.setup();
  const findings = Array.from({ length: 7 }, (_, i) => finding({ stageIds: [i], recommendation: `Broadcast stage ${i}` }));
  renderWidget(findings);

  expect(screen.getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
});

test('the per-widget evidence and confidence markers are Advanced-only', () => {
  store.getState().setWidgetDensity('basic');
  renderWidget([finding()]);
  expect(screen.queryByRole('button', { name: /evidence:/i })).not.toBeInTheDocument();
  cleanup();

  store.getState().setWidgetDensity('advanced');
  renderWidget([finding()]);
  expect(screen.getByRole('button', { name: /evidence:/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('card defaults collapsed and shows a finding-count summary', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget(
    [
      finding({ stageIds: [1], recommendation: 'Broadcast stage 1', impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } }),
      finding({ stageIds: [2], recommendation: 'Broadcast stage 2', impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } }),
    ],
    { defaultCollapsed: true },
  );
  // Lead value is the distinct stage count, not a repeat of the "Missed Broadcast Join" title.
  expect(screen.getByText('2 stages')).toBeInTheDocument();
  expect(screen.getByText('2 findings flagged')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Missed Broadcast Join' }));
  expect(screen.getByRole('button', { name: 'Stage' })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('confidence and evidence markers stay out of the summary view until the card is expanded', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget([finding({ confidence: 'medium', validationRequired: 'verify me' })], { defaultCollapsed: true });
  expect(screen.queryByText(/medium confidence/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /evidence:/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Missed Broadcast Join' }));
  expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /evidence:/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});
