// tests/view/speculation-waste.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { SpeculationWaste } from '@/view/widgets/SpeculationWaste';

function appModelWithStage(stageId: number): AppModel {
  return { ...emptyAppModel(), stages: new Map([[stageId, { id: stageId, name: `stage-${stageId}` }]]) as unknown as AppModel['stages'] };
}

test('renders nothing when the catalog has no speculationWaste findings', () => {
  const { container } = render(<SpeculationWaste appModel={emptyAppModel()} catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading, SPEC tag, formatted duration, and recommendation', () => {
  const catalog: Finding[] = [
    { type: 'speculationWaste', stageId: 7, impactBand: 'warning', value: 90000, recommendation: 'Tune spark.speculation settings for stage 7.' },
  ];
  render(<SpeculationWaste appModel={appModelWithStage(7)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Speculation Waste' })).toBeInTheDocument();
  expect(screen.getAllByText('SPEC').length).toBeGreaterThan(0);
  expect(screen.getByText('1m 30s')).toBeInTheDocument();
  expect(screen.getByText('Tune spark.speculation settings for stage 7.')).toBeInTheDocument();
});

test('shows the SPEC tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
  const catalog: Finding[] = [
    { type: 'speculationWaste', stageId: 1, impactBand: 'info', value: 60000, recommendation: 'r1' },
    { type: 'speculationWaste', stageId: 2, impactBand: 'warning', value: 90000, recommendation: 'r2' },
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  const { container } = render(<SpeculationWaste appModel={appModel} catalog={catalog} defaultCollapsed />);

  expect(screen.getByText('SPEC')).toBeInTheDocument();
  // One dot inside the header TagBadge itself, plus one per flagged stage row.
  expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
});

test('flags every affected stage, not just the worst', () => {
  const catalog: Finding[] = [
    { type: 'speculationWaste', stageId: 1, impactBand: 'info', value: 60000, recommendation: 'r1' },
    { type: 'speculationWaste', stageId: 2, impactBand: 'warning', value: 90000, recommendation: 'r2' },
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  render(<SpeculationWaste appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
});

test('renders the impact estimate for a flagged finding', () => {
  const catalog: Finding[] = [
    { type: 'speculationWaste', stageId: 7, impactBand: 'warning', value: 800, recommendation: 'r', impactEstimate: { basis: 'serial', wallClock: { low: 800, high: 800 }, estimateMethod: 'measured', rawWaste: { value: 800, unit: 'ms' } } },
  ];
  render(<SpeculationWaste appModel={appModelWithStage(7)} catalog={catalog} defaultCollapsed={false} />);
  expect(document.querySelector('.impact-estimate')).toHaveTextContent('800ms');
});

test('paginates the issue list 6-at-a-time', async () => {
  const user = userEvent.setup();
  const catalog: Finding[] = Array.from({ length: 7 }, (_, i) => ({
    type: 'speculationWaste' as const, stageId: i + 1, impactBand: 'warning' as const, value: 90000, recommendation: `r${i}`,
  }));
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map(catalog.map((f) => [f.stageId as number, { id: f.stageId }])) as unknown as AppModel['stages'] };
  render(<SpeculationWaste appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
});
