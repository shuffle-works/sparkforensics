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

test('surfaces the speculative-count detail with its single-clause recommendation always visible (no "; " split to gate)', () => {
  const catalog: Finding[] = [
    { type: 'straggler', stageId: 9, impactBand: 'critical', metric: 'speculativeTasks', value: 4, unit: 'count', recommendation: '4 speculative attempts discarded: investigate stragglers.' } as Finding,
  ];
  renderStraggler(appModelWithStage(9), catalog, false);
  expect(screen.getByRole('heading', { name: 'Stragglers' })).toBeInTheDocument();
  expect(screen.getByText(/4 speculative attempts discarded/)).toBeInTheDocument();
  expect(screen.getByText(/investigate stragglers/)).toBeInTheDocument();
});

test('splits a genuine two-clause recommendation: the general-cause advice is always visible, the skewed-key/AQE pointer is Advanced-only', async () => {
  const catalog: Finding[] = [
    {
      type: 'straggler', stageId: 9, impactBand: 'warning', metric: 'stragglerShare', value: 35, unit: 'pct',
      recommendation:
        "35% of tasks straggled: rule out a GC pause or a slow shuffle fetch before assuming a hardware issue; if a skewed key is the real cause, that's a candidate for AQE's skew-join handling.",
    } as Finding,
  ];
  renderStraggler(appModelWithStage(9), catalog, false);
  expect(screen.getByText(/rule out a GC pause or a slow shuffle fetch before assuming a hardware issue/)).toBeInTheDocument();
  expect(screen.queryByText(/AQE's skew-join handling/)).not.toBeInTheDocument();

  store.getState().setWidgetDensity('advanced');
  renderStraggler(appModelWithStage(9), catalog, false);
  expect(screen.getAllByText(/AQE's skew-join handling/).length).toBeGreaterThan(0);
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
      validationRequired: 'The 0.5%/2% runtime-floor percentages that gate this finding are our own noise floor, unvalidated.',
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
