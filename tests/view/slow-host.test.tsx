// tests/view/slow-host.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { emptyAppModel } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

const openStage = vi.fn();
vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage, close: vi.fn() }),
}));

import { SlowHost } from '@/view/widgets/SlowHost';

function appModelWithStage(stageId: number): AppModel {
  return { ...emptyAppModel(), stages: new Map([[stageId, { id: stageId, name: `stage-${stageId}` }]]) as unknown as AppModel['stages'] };
}

test('renders nothing when the catalog has no slowHost findings', () => {
  const { container } = render(<SlowHost appModel={emptyAppModel()} catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading and the SLOW... tag for a slowHost finding', () => {
  const catalog: Finding[] = [
    { type: 'slowHost', stageId: 4, impactBand: 'warning', metric: 'hostMeanRatio', value: 2.3, host: 'worker-3', hostTaskShare: 0.42, recommendation: 'Check executor logs for worker-3.' } as Finding,
  ];
  render(<SlowHost appModel={appModelWithStage(4)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Slow Executor Host' })).toBeInTheDocument();
  expect(screen.getAllByText('HOST').length).toBeGreaterThan(0);
  expect(screen.getByText('worker-3: 2.3× median task time (42% of tasks)')).toBeInTheDocument();
  expect(screen.getByText('Check executor logs for worker-3.')).toBeInTheDocument();
});

test('shows the HOST tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
  const catalog: Finding[] = [
    { type: 'slowHost', stageId: 1, impactBand: 'warning', metric: 'hostMeanRatio', value: 2, host: 'a', hostTaskShare: 0.3, recommendation: 'r1' } as Finding,
    { type: 'slowHost', stageId: 2, impactBand: 'critical', metric: 'hostMeanRatio', value: 4, host: 'b', hostTaskShare: 0.5, recommendation: 'r2' } as Finding,
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  const { container } = render(<SlowHost appModel={appModel} catalog={catalog} defaultCollapsed />);

  expect(screen.getByText('HOST')).toBeInTheDocument();
  // One dot inside the header TagBadge itself, plus one per flagged stage row.
  expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
});

test('flags every affected stage, not just the worst', () => {
  const catalog: Finding[] = [
    { type: 'slowHost', stageId: 1, impactBand: 'warning', metric: 'hostMeanRatio', value: 2, host: 'a', hostTaskShare: 0.3, recommendation: 'r1' } as Finding,
    { type: 'slowHost', stageId: 2, impactBand: 'critical', metric: 'hostMeanRatio', value: 4, host: 'b', hostTaskShare: 0.5, recommendation: 'r2' } as Finding,
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  render(<SlowHost appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
});

test('surfaces the per-host duration-share detail and its advice extension, always visible regardless of density', async () => {
  const catalog: Finding[] = [
    { type: 'slowHost', stageId: 4, impactBand: 'warning', metric: 'hostDurationShare', value: 0.82, host: 'worker-1', hostTaskShare: 0.6, recommendation: 'worker-1 is doing most of the work: consider salting the join key.' } as Finding,
  ];
  render(<SlowHost appModel={appModelWithStage(4)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText(/worker-1: 82% of this stage's task time \(60% of tasks\)/)).toBeInTheDocument();
  expect(screen.getByText(/consider salting the join key/)).toBeInTheDocument();

  const { store } = await import('@/store/store');
  store.getState().setWidgetDensity('advanced');
  render(<SlowHost appModel={appModelWithStage(4)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getAllByText(/consider salting the join key/).length).toBeGreaterThan(0);
  store.getState().setWidgetDensity('basic');
});

test('surfaces the per-executor multiDim detail with its advice always visible, regardless of density', async () => {
  const catalog: Finding[] = [
    { type: 'slowHost', stageId: 4, impactBand: 'info', metric: 'execMaxMedianRatio', value: 3.5, executorId: '7', dimension: 'shuffleBytes', recommendation: 'Executor 7 deviates on shuffleBytes: check for a hot key.' } as Finding,
  ];
  render(<SlowHost appModel={appModelWithStage(4)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText(/Executor 7: 3\.5× median on shuffleBytes/)).toBeInTheDocument();
  expect(screen.getByText(/check for a hot key/)).toBeInTheDocument();

  // Density doesn't change anything for this sub-rule: still visible at Advanced.
  const { store } = await import('@/store/store');
  store.getState().setWidgetDensity('advanced');
  render(<SlowHost appModel={appModelWithStage(4)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getAllByText(/check for a hot key/).length).toBeGreaterThan(0);
  store.getState().setWidgetDensity('basic');
});

test('renders the impact estimate for a flagged finding', () => {
  const catalog: Finding[] = [
    { type: 'slowHost', stageId: 4, impactBand: 'warning', metric: 'hostMeanRatio', value: 2, host: 'a', hostTaskShare: 0.3, recommendation: 'r', impactEstimate: { basis: 'serial', wallClock: { low: 800, high: 800 }, estimateMethod: 'measured', rawWaste: { value: 800, unit: 'ms' } } } as Finding,
  ];
  render(<SlowHost appModel={appModelWithStage(4)} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('800ms')).toBeInTheDocument();
});

test('paginates the issue list 6-at-a-time', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  const catalog: Finding[] = Array.from({ length: 7 }, (_, i) => ({
    type: 'slowHost', stageId: i + 1, impactBand: 'warning', metric: 'hostMeanRatio', value: 2, host: `h${i}`, hostTaskShare: 0.3, recommendation: `r${i}`,
  } as Finding));
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map(catalog.map((f) => [f.stageId as number, { id: f.stageId }])) as unknown as AppModel['stages'] };
  render(<SlowHost appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
});
