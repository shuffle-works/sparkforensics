// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const openStage = vi.fn();
vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage, close: vi.fn() }),
}));

import { emptyAppModel } from '@sparkforensics/core/export';
import type { AppModel, Finding } from '@sparkforensics/core/types';

import { StageSlowness } from '@/view/widgets/StageSlowness';
import { installInterpretation } from './_shared/interpretation';

function appModelWithStage(stageId: number): AppModel {
  return { ...emptyAppModel(), stages: new Map([[stageId, { id: stageId, name: `stage-${stageId}` }]]) as unknown as AppModel['stages'] };
}

test('renders nothing when the catalog has no stageSlowness findings', () => {
  const { container } = render(<StageSlowness appModel={emptyAppModel()} catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading, SLOW tag, stage-duration metric and the card\'s fix', () => {
  const catalog: Finding[] = [
    { type: 'stageSlowness', stageId: 3, impactBand: 'warning', value: 40, recommendation: 'Profile the query plan for stage 3.' },
  ];
  render(<StageSlowness appModel={appModelWithStage(3)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Slow Stage' })).toBeInTheDocument();
  expect(screen.getAllByText('SLOW').length).toBeGreaterThan(0);
  expect(screen.getByText('40m stage duration', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByText(/^Often a partition-count problem/)).toBeInTheDocument();
  expect(screen.queryByText('Profile the query plan for stage 3.')).not.toBeInTheDocument();
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
  installInterpretation(catalog);
  render(<StageSlowness appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
});

test('hides the sort toggle at basic density', () => {
  const catalog: Finding[] = [
    { type: 'stageSlowness', stageId: 1, impactBand: 'warning', value: 16, recommendation: 'r1', impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured', stageTaskMs: 1000 } },
    { type: 'stageSlowness', stageId: 2, impactBand: 'warning', value: 40, recommendation: 'r2', impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured', stageTaskMs: 9000 } },
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  render(<StageSlowness appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
});
