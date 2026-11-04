// tests/view/speculation-waste.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { emptyAppModel } from '@sparkforensics/core/export';
import type { AppModel, Finding } from '@sparkforensics/core/types';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { SpeculationWaste } from '@/view/widgets/SpeculationWaste';
import { installInterpretation } from './_shared/interpretation';

function appModelWithStage(stageId: number): AppModel {
  return { ...emptyAppModel(), stages: new Map([[stageId, { id: stageId, name: `stage-${stageId}` }]]) as unknown as AppModel['stages'] };
}

test('renders nothing when the catalog has no speculationWaste findings', () => {
  const { container } = render(<SpeculationWaste appModel={emptyAppModel()} catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading, SPEC tag, formatted duration, and the card\'s fix', () => {
  const catalog: Finding[] = [
    { type: 'speculationWaste', stageId: 7, impactBand: 'warning', value: 90000, recommendation: 'Tune spark.speculation settings for stage 7.' },
  ];
  render(<SpeculationWaste appModel={appModelWithStage(7)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Speculation Waste' })).toBeInTheDocument();
  expect(screen.getAllByText('SPEC').length).toBeGreaterThan(0);
  expect(screen.getByText('1m 30s')).toBeInTheDocument();
  expect(screen.getByText(/^If task durations are naturally variable/)).toBeInTheDocument();
  expect(screen.queryByText('Tune spark.speculation settings for stage 7.')).not.toBeInTheDocument();
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
  installInterpretation(catalog);
  render(<SpeculationWaste appModel={appModelWithStage(7)} catalog={catalog} defaultCollapsed={false} />);
  expect(document.querySelector('.impact-estimate')).toHaveTextContent('800ms');
});
