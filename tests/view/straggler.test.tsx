// tests/view/straggler.test.tsx
// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { StageDetailProvider } from '@/view/StageDetailContext';

import { Straggler } from '@/view/widgets/Straggler';

function appModelWithStage(stageId: number): AppModel {
  return { ...emptyAppModel(), stages: new Map([[stageId, { id: stageId, name: `stage-${stageId}` }]]) as unknown as AppModel['stages'] };
}

function renderStraggler(appModel: AppModel, catalog: Finding[], defaultCollapsed?: boolean) {
  return render(
    <StageDetailProvider>
      <Straggler appModel={appModel} catalog={catalog} defaultCollapsed={defaultCollapsed} />
    </StageDetailProvider>,
  );
}

test('renders nothing when the catalog has no straggler findings', () => {
  const { container } = renderStraggler(emptyAppModel(), []);
  expect(container).toBeEmptyDOMElement();
});

test('surfaces the speculative-count detail and the card\'s fix', () => {
  const catalog: Finding[] = [
    { type: 'straggler', stageId: 9, impactBand: 'critical', metric: 'speculativeTasks', value: 4, unit: 'count', recommendation: '4 speculative attempts discarded: investigate stragglers.' } as Finding,
  ];
  renderStraggler(appModelWithStage(9), catalog, false);
  expect(screen.getByRole('heading', { name: 'Stragglers' })).toBeInTheDocument();
  expect(screen.getByText(/4 speculative attempts discarded/)).toBeInTheDocument();
  expect(screen.getByText(/^Nothing in the log attributes the slow tasks/)).toBeInTheDocument();
});

test('states the card\'s fix for a tail with no measured cause, with no skew-key advice, at every density', async () => {
  const catalog: Finding[] = [
    {
      type: 'straggler', stageId: 9, impactBand: 'warning', metric: 'stragglerShare', value: 35, unit: 'pct',
      recommendation:
        "35% of tasks straggled: rule out a GC pause or a slow shuffle fetch before assuming a hardware issue; if a skewed key is the real cause, that's a candidate for AQE's skew-join handling.",
    } as Finding,
  ];
  renderStraggler(appModelWithStage(9), catalog, false);
  expect(screen.getByText(/check their input sizes, GC time and hosts before choosing a fix/)).toBeInTheDocument();
  expect(screen.queryByText(/AQE skew-join handling|salt the key/)).toBeNull();

  store.getState().setWidgetDensity('advanced');
  renderStraggler(appModelWithStage(9), catalog, false);
  expect(screen.getAllByText(/check their input sizes, GC time and hosts before choosing a fix/).length).toBeGreaterThan(0);
  store.getState().setWidgetDensity('basic');
});

test('surfaces the stragglerShare percentage detail', () => {
  const catalog: Finding[] = [
    { type: 'straggler', stageId: 9, impactBand: 'warning', metric: 'stragglerShare', value: 35, unit: 'pct', recommendation: '35% of tasks straggled: investigate stragglers.' } as Finding,
  ];
  renderStraggler(appModelWithStage(9), catalog, false);
  expect(screen.getByText(/35% of tasks straggled/)).toBeInTheDocument();
});

test('flags every affected stage, not just the worst', () => {
  const catalog: Finding[] = [
    { type: 'straggler', stageId: 1, impactBand: 'warning', metric: 'stragglerShare', value: 10, unit: 'pct', recommendation: 'r1' } as Finding,
    { type: 'straggler', stageId: 2, impactBand: 'critical', metric: 'stragglerShare', value: 30, unit: 'pct', recommendation: 'r2' } as Finding,
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  renderStraggler(appModel, catalog, false);
  expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
});

test('shows the STRAG tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
  const catalog: Finding[] = [
    { type: 'straggler', stageId: 1, impactBand: 'warning', metric: 'stragglerShare', value: 10, unit: 'pct', recommendation: 'r1' } as Finding,
    { type: 'straggler', stageId: 2, impactBand: 'critical', metric: 'stragglerShare', value: 30, unit: 'pct', recommendation: 'r2' } as Finding,
  ];
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map([[1, { id: 1 }], [2, { id: 2 }]]) as unknown as AppModel['stages'] };
  const { container } = renderStraggler(appModel, catalog, true);

  expect(screen.getByText('STRAG')).toBeInTheDocument();
  // One dot inside the header TagBadge itself, plus one per flagged stage row.
  expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
});

test('shows a confidence caveat when the straggler finding carries one', () => {
  const catalog: Finding[] = [
    {
      type: 'straggler', stageId: 9, impactBand: 'warning', metric: 'stragglerShare', value: 35, unit: 'pct',
      recommendation: '35% of tasks straggled: investigate stragglers.',
      confidence: 'low',
      validationRequired: 'This finding is gated by 0.5%/2% runtime-floor thresholds, our own noise floor for this metric.',
    } as Finding,
  ];
  store.getState().setWidgetDensity('advanced');
  renderStraggler(appModelWithStage(9), catalog, false);

  const caveat = screen.getByText(/low confidence/i);
  expect(caveat).toBeInTheDocument();
  expect(caveat.getAttribute('title')).toBe(catalog[0].validationRequired);
  store.getState().setWidgetDensity('basic');
});

test('paginates the issue list 6-at-a-time', async () => {
  const user = userEvent.setup();
  const catalog: Finding[] = Array.from({ length: 7 }, (_, i) => ({
    type: 'straggler', stageId: i + 1, impactBand: 'warning', metric: 'stragglerShare', value: 10, unit: 'pct', recommendation: `r${i}`,
  } as Finding));
  const appModel: AppModel = { ...emptyAppModel(), stages: new Map(catalog.map((f) => [f.stageId as number, { id: f.stageId }])) as unknown as AppModel['stages'] };
  renderStraggler(appModel, catalog, false);
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
});

test('names the measured cause of the slow tail', () => {
  const catalog: Finding[] = [
    { type: 'straggler', stageId: 9, impactBand: 'warning', metric: 'stragglerShare', value: 12, unit: 'pct', cause: 'host', causeSharePct: 80, host: 'worker-7', hostTasks: 9, recommendation: 'r' } as Finding,
  ];
  renderStraggler(appModelWithStage(9), catalog, false);
  expect(screen.getByText('Tasks piled on worker-7 (80% of their extra time)')).toBeInTheDocument();
});
