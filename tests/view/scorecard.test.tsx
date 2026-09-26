// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Scorecard } from '../../src/view/widgets/Scorecard';
import { store } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

function makeAppModel(overrides: Partial<AppModel> = {}): AppModel {
  return {
    app: { startTime: 0, endTime: 60000, sparkVersion: '3.5.3' },
    stages: new Map([[0, { id: 0, submittedAt: 0, completedAt: 1000 }]]),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    ...overrides,
    evidenceAvailability: overrides.evidenceAvailability ?? null,
  };
}

test('renders the wall-clock and efficiency KPI labels', () => {
  render(<Scorecard appModel={makeAppModel()} catalog={[]} />);
  expect(screen.getByText('Wall-clock')).toBeInTheDocument();
  expect(screen.getByText('Efficiency')).toBeInTheDocument();
});

test('Basic view says what each tile measures and which direction is better', () => {
  render(<Scorecard appModel={makeAppModel()} catalog={[]} />);
  expect(screen.getByTestId('kpi-wall-clock')).toHaveTextContent('Total run time. Stages were running for 1.0s of it.');
  expect(screen.getByTestId('kpi-efficiency')).toHaveTextContent('Share of the run with a stage running. Higher is better.');
});

test('Advanced view keeps the raw run/idle breakdown behind a measured Efficiency percentage', () => {
  store.getState().setWidgetDensity('advanced');
  try {
    render(<Scorecard appModel={makeAppModel()} catalog={[]} />);
    expect(screen.getByTestId('kpi-wall-clock')).toHaveTextContent('Ran 1.0s');
    expect(screen.getByTestId('kpi-efficiency')).toHaveTextContent(/Ran 1\.0s · 59\.0s idle\/gap time/);
  } finally {
    store.getState().setWidgetDensity('basic');
  }
});

test('spells out zero stage activity instead of the "no measurable value" dash, so a run with no stages does not look like broken data', () => {
  render(<Scorecard appModel={makeAppModel({ stages: new Map() })} catalog={[]} />);
  expect(screen.getByTestId('kpi-wall-clock')).toHaveTextContent('No stage activity recorded');
  store.getState().setWidgetDensity('advanced');
  try {
    render(<Scorecard appModel={makeAppModel({ stages: new Map() })} catalog={[]} />);
    // With no finished stage there is nothing to grade: no "0%", in either view.
    for (const tile of screen.getAllByTestId('kpi-efficiency')) {
      expect(tile).toHaveTextContent('Not measured');
      expect(tile).toHaveTextContent('No stage in this log recorded an end');
      expect(tile).not.toHaveTextContent('%');
    }
  } finally {
    store.getState().setWidgetDensity('basic');
  }
});

test.each([
  [{ startTime: 0 }],
  [{ startTime: 10, endTime: 10 }],
  [{ startTime: 20, endTime: 10 }],
  [{ startTime: Number.NaN, endTime: 10 }],
  [{ startTime: 0, endTime: Number.POSITIVE_INFINITY }],
])('collapses to a single unavailable notice for incomplete timing, instead of three separate Unavailable tiles', (app) => {
  render(<Scorecard appModel={makeAppModel({ app })} catalog={[]} />);
  expect(screen.getByText(/no complete application timing interval/i)).toBeInTheDocument();
  expect(screen.queryByTestId('kpi-wall-clock')).not.toBeInTheDocument();
  expect(screen.queryByTestId('kpi-efficiency')).not.toBeInTheDocument();
  expect(screen.queryByTestId('kpi-wastage')).not.toBeInTheDocument();
  expect(screen.queryAllByText('Unavailable')).toHaveLength(0);
});

test('renders an Unused core time tile driven by computeEfficiencyModel when runAggregates is present, with a tier-appropriate caption', () => {
  const appModel = makeAppModel({
    app: { startTime: 0, endTime: 60000, sparkVersion: '3.5.3', resources: { executor: { cores: 2 } } },
    executors: { added: [{ kind: 'added', executorId: '1', timestamp: 0, host: 'host-1', totalCores: 2, resourceProfileId: null }], removed: [] },
    runAggregates: { busyCoreMs: 10, perStage: { 0: { totalTaskDurationSum: 10, taskCount: 1 } } },
  });

  const { rerender } = render(<Scorecard appModel={appModel} catalog={[]} />);
  expect(screen.getByTestId('kpi-wastage')).toHaveTextContent('Unused core time100%');
  expect(screen.getByText('Driver idle plus executor slack across the whole run, so it can run higher than the idle capacity a verdict step reports. Lower is better. Not a cost figure.')).toBeInTheDocument();

  store.getState().setWidgetDensity('advanced');
  rerender(<Scorecard appModel={appModel} catalog={[]} />);
  expect(screen.getByText(/driver-idle \+ executor-slack core-hours as a share of available capacity\. directional, not a cost figure\./i)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test.each([
  [null, { startTime: 0, endTime: 60_000, resources: { executor: { cores: 2 } } }, 'core-usage summary'],
  [{ busyCoreMs: 10 }, { startTime: 0, endTime: 60_000 }, 'executor-capacity data'],
])('keeps Wastage visible and unavailable without %s', (runAggregates, app, reason) => {
  render(<Scorecard appModel={makeAppModel({ app, runAggregates } as Partial<AppModel>)} catalog={[]} />);
  const tile = screen.getByTestId('kpi-wastage');
  expect(tile).toHaveTextContent('Unavailable');
  expect(tile).toHaveTextContent(new RegExp(reason, 'i'));
  expect(tile).not.toHaveTextContent('0%');
});

test('a flagged tile carries an inset accent shadow, not a border-left, so the grid divider under an unflagged neighbor stays visible', () => {
  // Default fixture: 1s of stage activity across a 60s run is a critical
  // (<75%) efficiency, so this exercises the real flagged-tile styling
  // without a bespoke fixture.
  render(<Scorecard appModel={makeAppModel()} catalog={[]} />);
  const efficiency = screen.getByTestId('kpi-efficiency');
  const wallClock = screen.getByTestId('kpi-wall-clock'); // never flagged

  // A border-left utility on the tile itself (even `border-transparent`)
  // would override the parent grid's `divide-x`/`divide-y` separator on
  // the same CSS property, silently erasing the boundary between two
  // healthy tiles; the accent must be a box-shadow instead.
  expect(efficiency.style.boxShadow).toContain('var(--color-critical)');
  expect(efficiency.className).not.toMatch(/\bborder-l-4\b/);
  expect(wallClock.style.boxShadow).toBe('');
  expect(wallClock.className).not.toMatch(/\bborder-l-4\b/);
});

test('renders no domain/company strings', () => {
  const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];
  const { container } = render(<Scorecard appModel={makeAppModel()} catalog={catalog} />);
  expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
});
