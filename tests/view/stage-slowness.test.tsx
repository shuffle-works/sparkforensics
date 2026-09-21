// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openStage = vi.fn();
vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage, close: vi.fn() }),
}));
vi.mock('@/view/TriageNavigationContext', () => ({
  useActiveRouteTarget: () => null,
  useTriageNavigation: () => ({
    registerWidget: vi.fn(),
    registerFindingAnchor: vi.fn(() => vi.fn()),
    reportWidgetOpen: vi.fn(),
    clearRouteFocus: vi.fn(),
  }),
  useRouteFocusedWidgetId: () => null,
  useRouteFlashedFinding: () => null,
}));

import { emptyAppModel, store } from '@/store/store';
import { expectImpactThenStageOrderByAccessibleName } from './_shared/sort-order-toggle';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

import { StageSlowness } from '@/view/widgets/StageSlowness';

function appModelWithStage(stageId: number): AppModel {
  return { ...emptyAppModel(), stages: new Map([[stageId, { id: stageId, name: `stage-${stageId}` }]]) as unknown as AppModel['stages'] };
}

test('renders nothing when the catalog has no stageSlowness findings', () => {
  const { container } = render(<StageSlowness appModel={emptyAppModel()} catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading, SLOW tag, and stage-duration metric', () => {
  const catalog: Finding[] = [
    { type: 'stageSlowness', stageId: 3, impactBand: 'warning', value: 40, recommendation: 'Profile the query plan for stage 3.' },
  ];
  render(<StageSlowness appModel={appModelWithStage(3)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Slow Stage' })).toBeInTheDocument();
  expect(screen.getAllByText('SLOW').length).toBeGreaterThan(0);
  expect(screen.getByText('40m stage duration', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByText('Profile the query plan for stage 3.')).toBeInTheDocument();
});

test('shows the SLOW tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
  const catalog: Finding[] = [
    { type: 'stageSlowness', stageId: 1, impactBand: 'info', value: 16, recommendation: 'r1' },
    { type: 'stageSlowness', stageId: 2, impactBand: 'warning', value: 40, recommendation: 'r2' },
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  const { container } = render(<StageSlowness appModel={appModel} catalog={catalog} defaultCollapsed />);

  expect(screen.getByText('SLOW')).toBeInTheDocument();
  // One dot inside the header TagBadge itself, plus one per flagged stage row.
  expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
});

test('flags every affected stage, not just the worst', () => {
  const catalog: Finding[] = [
    { type: 'stageSlowness', stageId: 1, impactBand: 'info', value: 16, recommendation: 'r1' },
    { type: 'stageSlowness', stageId: 2, impactBand: 'warning', value: 40, recommendation: 'r2' },
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  render(<StageSlowness appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
});

test('defaults to impact order (highest potential savings first), and a toggle flips it back to stage order at advanced density', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const catalog: Finding[] = [
    { type: 'stageSlowness', stageId: 1, impactBand: 'warning', value: 16, recommendation: 'r1', impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } },
    { type: 'stageSlowness', stageId: 2, impactBand: 'warning', value: 40, recommendation: 'r2', impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } },
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  render(<StageSlowness appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  const rows = () => screen.getAllByRole('button', { name: /open details for stage \d/i });
  await expectImpactThenStageOrderByAccessibleName(user, rows, /stage 1/i, /stage 2/i);
  store.getState().setWidgetDensity('basic');
});

test('hides the sort toggle at basic density', () => {
  const catalog: Finding[] = [
    { type: 'stageSlowness', stageId: 1, impactBand: 'warning', value: 16, recommendation: 'r1', impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } },
    { type: 'stageSlowness', stageId: 2, impactBand: 'warning', value: 40, recommendation: 'r2', impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } },
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  render(<StageSlowness appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
});

test('paginates the issue list 6-at-a-time', async () => {
  const user = userEvent.setup();
  const catalog: Finding[] = Array.from({ length: 7 }, (_, i) => ({
    type: 'stageSlowness' as const, stageId: i + 1, impactBand: 'warning' as const, value: 40, recommendation: `r${i}`,
  }));
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map(catalog.map((f) => [f.stageId as number, { id: f.stageId }])) as unknown as AppModel['stages'] };
  render(<StageSlowness appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
});
