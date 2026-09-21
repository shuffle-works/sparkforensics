// @vitest-environment jsdom
import { test, expect, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '@/App';
import { auditConfig } from '@sparkforensics/core/analyzer.ts';
import { store, emptyAppModel } from '@/store/store';
import type { Finding } from '@sparkforensics/core/types.ts';

function readyAppModel() {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 60_000 },
    stages: new Map([
      [1, { id: 1, submittedAt: 0, completedAt: 1000 }],
      [2, { id: 2, submittedAt: 0, completedAt: 1000 }],
    ]),
  };
}

async function waitForDashboard() {
  return screen.findByRole('tab', { name: 'Findings' });
}

// A row's stable selector is its `data-finding-type`; a repeated type collapses
// into a group row instead of a per-finding row.
function hasFixTheseFirstRow(type: string) {
  return screen.queryAllByTestId('fix-these-first-row').some((row) => row.dataset.findingType === type)
    || screen.queryAllByTestId('fix-these-first-group-row').some((row) => row.dataset.findingType === type);
}

type User = ReturnType<typeof userEvent.setup>;

// Type/Stage live in modal dropdowns, so these helpers close the menu after
// ticking an item, or it would block the background assertions.
async function clickImpact(user: User, band: string) {
  await user.click(screen.getByRole('button', { name: `Filter by impact: ${band}` }));
}
async function clickDimension(user: User, dimension: 'type' | 'stage', value: string | number) {
  await user.click(screen.getByRole('button', { name: new RegExp(`filter by ${dimension}`, 'i') }));
  await user.click(await screen.findByRole('menuitemcheckbox', { name: `Filter by ${dimension}: ${value}` }));
  await user.keyboard('{Escape}');
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  store.setState({
    appModel: emptyAppModel(), catalog: [], configFindings: [], status: 'idle', errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
  });
});

test('a stage filter narrows the board to the selected stage', async () => {
  const user = userEvent.setup();
  const catalog: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'critical', recommendation: 'x' },
    { type: 'skew', stageId: 2, impactBand: 'warning', recommendation: 'y' },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog });
  render(<App />);
  await waitForDashboard();

  await clickDimension(user, 'stage', 1);
  // The live-region count guards actual board filtering, not just URL sync.
  expect(screen.getByText('1 finding matches the active filters')).toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get('stage')).toBe('1');
});

test('filtered-to-empty shows the distinct no-match banner with an inline clear, not the no-bottlenecks banner', async () => {
  const user = userEvent.setup();
  // `critical` matches only the stage-2 finding and `stage 1` only the stage-1
  // finding, so their intersection is empty: the empty state.
  const catalog: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'warning' },
    { type: 'skew', stageId: 2, impactBand: 'critical' },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog });
  render(<App />);
  await waitForDashboard();

  await clickImpact(user, 'critical');
  await clickDimension(user, 'stage', 1);
  expect(screen.getByText(/no findings match the active filters/i)).toBeInTheDocument();

  await user.click(within(screen.getByText(/no findings match/i).closest('div')!.parentElement!)
    .getByRole('button', { name: /clear all filters/i }));
  expect(screen.queryByText(/no findings match the active filters/i)).not.toBeInTheDocument();
});

test('empty catalog still shows the no-findings-to-fix empty state (distinct from no-match)', async () => {
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog: [] });
  render(<App />);
  await waitForDashboard();
  expect(screen.getByText(/no findings to fix/i)).toBeInTheDocument();
  expect(screen.queryByText(/no findings match the active filters/i)).not.toBeInTheDocument();
});

test('mounting with URL filter params filters the board on load', async () => {
  window.history.replaceState({}, '', '/?impact=critical');
  const catalog: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'critical' },
    { type: 'skew', stageId: 2, impactBand: 'info' },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog });
  render(<App />);
  await waitForDashboard();
  expect(screen.getByRole('button', { name: 'Filter by impact: critical' })).toHaveAttribute('aria-pressed', 'true');
});

test('an active stage filter drops the configAudit row from All recommendations', async () => {
  const user = userEvent.setup();
  const appModel = readyAppModel() as any;
  appModel.app = { ...appModel.app, config: { 'spark.dynamicAllocation.maxExecutors': '10' }, resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false } };
  const catalog: Finding[] = [{ type: 'spill', stageId: 1, impactBand: 'warning' }];
  store.setState({ status: 'ready', appModel, catalog, configFindings: auditConfig(appModel.app) });
  render(<App />);
  await waitForDashboard();

  expect(hasFixTheseFirstRow('configAudit')).toBe(true);

  await clickDimension(user, 'stage', 1);
  expect(hasFixTheseFirstRow('configAudit')).toBe(false);
});

test('filtering to a CFG-only type keeps config matches and does not show the no-match banner', async () => {
  const user = userEvent.setup();
  const appModel = readyAppModel() as any;
  appModel.app = { ...appModel.app, config: { 'spark.dynamicAllocation.maxExecutors': '10' }, resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false } };
  const catalog: Finding[] = [{ type: 'spill', stageId: 1, impactBand: 'warning' }];
  store.setState({ status: 'ready', appModel, catalog, configFindings: auditConfig(appModel.app) });
  render(<App />);
  await waitForDashboard();

  // configAudit lives only in the config stream, so filteredCatalog empties but
  // filteredConfig still matches: no no-match banner, configAudit row stays.
  await clickDimension(user, 'type', 'configAudit');
  expect(screen.queryByText(/no findings match the active filters/i)).not.toBeInTheDocument();
  expect(hasFixTheseFirstRow('configAudit')).toBe(true);
});

test('switching to a different file clears the previous file\'s filter (no reparse)', async () => {
  const user = userEvent.setup();
  const catalogA: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'warning' },
    { type: 'skew', stageId: 2, impactBand: 'critical' },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog: catalogA, activeFileId: 'file-A' });
  render(<App />);
  await waitForDashboard();

  // Filter file A down to an empty intersection.
  await clickImpact(user, 'critical');
  await clickDimension(user, 'stage', 1);
  expect(screen.getByText(/no findings match the active filters/i)).toBeInTheDocument();
  expect(window.location.search).not.toBe('');

  // Switch files with no reparse (dashboard stays mounted); the stale filter must drop.
  await act(async () => {
    store.setState({ catalog: [{ type: 'spill', stageId: 1, impactBand: 'warning' }], activeFileId: 'file-B' });
    await Promise.resolve();
  });

  expect(screen.queryByText(/no findings match the active filters/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^remove filter/i })).not.toBeInTheDocument();
  expect(window.location.search).toBe('');
});
