// @vitest-environment jsdom
import { test, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
      [3, { id: 3, submittedAt: 0, completedAt: 1000 }],
      [4, { id: 4, submittedAt: 0, completedAt: 1000 }],
      [5, { id: 5, submittedAt: 0, completedAt: 1000 }],
    ]),
  };
}

// The verdict owns the top three findings (by potential savings) and the
// Findings tab lists the rest. These three, each with a saving no other test
// finding has, fill the verdict so the finding under test lands in the board.
function verdictLeads(impactBand: Finding['impactBand'] = 'warning'): Finding[] {
  const saving = { basis: 'serial', wallClock: { low: 9_000, high: 9_000 }, estimateMethod: 'modeled' } as Finding['impactEstimate'];
  return [
    { type: 'gc', stageId: 3, impactBand, recommendation: 'Lead gc.', impactEstimate: saving },
    { type: 'shuffle', stageId: 4, impactBand, recommendation: 'Lead shuffle.', impactEstimate: saving },
    { type: 'partitionSizing', stageId: 5, impactBand, recommendation: 'Lead partitions.', impactEstimate: saving },
  ] as Finding[];
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
    // The filter bar is an Advanced-mode control; the Basic-mode visibility
    // rules have their own tests at the end of this file.
    widgetDensity: 'advanced',
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

test('an active stage filter drops the configAudit row from the Findings tab', async () => {
  const user = userEvent.setup();
  const appModel = readyAppModel() as any;
  appModel.app = { ...appModel.app, config: { 'spark.app.name': 'demo' }, resources: { dynamicAllocationEnabled: true } };
  const catalog: Finding[] = [{ type: 'spill', stageId: 1, impactBand: 'warning' }, ...verdictLeads()];
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
  appModel.app = { ...appModel.app, config: { 'spark.app.name': 'demo' }, resources: { dynamicAllocationEnabled: true } };
  const catalog: Finding[] = [{ type: 'spill', stageId: 1, impactBand: 'warning' }, ...verdictLeads()];
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

test('Basic mode hides the filter bar while no filter is active', async () => {
  store.setState({
    status: 'ready', appModel: readyAppModel() as any, widgetDensity: 'basic',
    catalog: [{ type: 'spill', stageId: 1, impactBand: 'critical', recommendation: 'x' }],
  });
  render(<App />);
  await waitForDashboard();
  expect(screen.queryByRole('region', { name: 'Filter findings' })).not.toBeInTheDocument();
});

test('Basic mode still shows the filter bar when a filter is active, so it can be read and cleared', async () => {
  window.history.replaceState({}, '', '/?stage=1');
  store.setState({
    status: 'ready', appModel: readyAppModel() as any, widgetDensity: 'basic',
    catalog: [
      { type: 'spill', stageId: 1, impactBand: 'critical', recommendation: 'x' },
      { type: 'skew', stageId: 2, impactBand: 'warning', recommendation: 'y' },
    ],
  });
  render(<App />);
  await waitForDashboard();
  expect(screen.getByRole('region', { name: 'Filter findings' })).toBeInTheDocument();
  expect(screen.getByText('1 finding matches the active filters')).toBeInTheDocument();
});

test('Show evidence in the stage dialog clears the filter that hides the target, and says so', async () => {
  const user = userEvent.setup();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  window.history.replaceState({}, '', '/?type=spill');
  store.setState({
    status: 'ready', appModel: readyAppModel() as any,
    catalog: [
      { type: 'spill', stageId: 1, impactBand: 'critical', recommendation: 'Fix spill.' },
      { type: 'skew', stageId: 1, impactBand: 'warning', recommendation: 'Fix skew.' },
    ],
  });
  render(<App />);
  await waitForDashboard();
  expect(hasFixTheseFirstRow('skew')).toBe(false);

  await user.click(screen.getByRole('button', { name: 'Stage 1' }));
  const dialog = await screen.findByRole('dialog');
  const skewStep = within(dialog).getAllByTestId('stage-finding').find((step) => step.textContent?.includes('Fix skew.'))!;
  await user.click(within(skewStep).getByRole('button', { name: /show evidence/i }));

  expect(screen.getByText('Cleared the spill filter to show this finding.')).toHaveAttribute('role', 'status');
  expect(hasFixTheseFirstRow('skew')).toBe(true);
  expect(new URLSearchParams(window.location.search).get('type')).toBeNull();
});

test('a verdict step that routes to another step\'s card clears only the dimension that hides it, and says so', async () => {
  const user = userEvent.setup();
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
  window.history.replaceState({}, '', '/?impact=critical&type=skew');
  const saving = (ms: number) => ({ basis: 'serial', wallClock: { low: ms, high: ms }, estimateMethod: 'modeled' }) as Finding['impactEstimate'];
  store.setState({
    status: 'ready', appModel: readyAppModel() as any,
    catalog: [
      { type: 'spill', stageId: 1, impactBand: 'critical', recommendation: 'Fix spill.', impactEstimate: saving(9_000) },
      { type: 'spill', stageId: 2, impactBand: 'critical', recommendation: 'Fix more spill.', impactEstimate: saving(8_000) },
      { type: 'skew', stageId: 2, impactBand: 'critical', recommendation: 'Fix skew.' },
    ],
  });
  render(<App />);
  await waitForDashboard();

  const steps = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step');
  expect(steps[0]).toHaveTextContent('Stage 1');
  // The first spill step shows its card in place, which no board filter can hide: nothing is cleared.
  await user.click(within(steps[0]).getByRole('button', { name: /show evidence/i }));
  expect(screen.queryByText(/Cleared the .* filter/)).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get('type')).toBe('skew');

  // The second spill step shares that card, so it routes to it and clears the type filter hiding spill.
  expect(steps[1]).toHaveTextContent('Stage 2');
  await user.click(within(steps[1]).getByRole('button', { name: /show evidence/i }));

  expect(screen.getByText('Cleared the task skew filter to show this finding.')).toHaveAttribute('role', 'status');
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  const params = new URLSearchParams(window.location.search);
  expect(params.get('type')).toBeNull();
  expect(params.get('impact')).toBe('critical');

  await clickImpact(user, 'critical');
  expect(screen.queryByText('Cleared the task skew filter to show this finding.')).not.toBeInTheDocument();
  // @ts-expect-error -- restore jsdom's default (no scrollIntoView)
  delete Element.prototype.scrollIntoView;
});

test('a verdict step for a Full app report widget leaves the board filter alone', async () => {
  const user = userEvent.setup();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  window.history.replaceState({}, '', '/?type=spill');
  store.setState({
    status: 'ready', appModel: readyAppModel() as any,
    catalog: [
      { type: 'spill', stageId: 1, impactBand: 'warning', recommendation: 'Fix spill.' },
      { type: 'coreLocality', stageId: null, impactBand: 'critical', value: 40, recommendation: 'Check locality.', nonLocalTaskCount: 0 },
    ],
  });
  render(<App />);
  await waitForDashboard();

  const localityStep = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step')
    .find((step) => step.textContent?.includes('Check locality.'))!;
  await user.click(within(localityStep).getByRole('button', { name: /show evidence/i }));

  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'true');
  expect(new URLSearchParams(window.location.search).get('type')).toBe('spill');
  await user.click(screen.getByRole('tab', { name: 'Findings' }));
  expect(screen.queryByText(/Cleared the .* filter/)).not.toBeInTheDocument();
  // @ts-expect-error -- restore jsdom's default (no scrollIntoView)
  delete Element.prototype.scrollIntoView;
});

test('the top bar count chip clears the filter that hides the band it counts, and lands on it', async () => {
  const user = userEvent.setup();
  window.history.replaceState({}, '', '/?type=spill&stage=1');
  store.setState({
    status: 'ready', appModel: readyAppModel() as any,
    catalog: [
      { type: 'spill', stageId: 1, impactBand: 'warning', recommendation: 'Fix spill.' },
      { type: 'skew', stageId: 1, impactBand: 'critical', recommendation: 'Fix skew.' },
      { type: 'skew', stageId: 2, impactBand: 'critical', recommendation: 'Fix skew.' },
      ...verdictLeads('critical'),
    ],
  });
  render(<App />);
  await waitForDashboard();
  // With the verdict's steps holding F1-F3, the bands in Findings are sub-headings of "More findings".
  expect(screen.queryByRole('heading', { level: 3, name: 'Critical' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '5 critical: show them in Findings' }));

  expect(screen.getByText('Cleared the spill filter to show the critical findings.')).toHaveAttribute('role', 'status');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Critical' })));
  const params = new URLSearchParams(window.location.search);
  expect(params.get('type')).toBeNull();
  expect(params.get('stage')).toBe('1');
});

test('the top bar count chip reveals a band whose only finding is core locality', async () => {
  const user = userEvent.setup();
  window.history.replaceState({}, '', '/?type=spill');
  store.setState({
    status: 'ready', appModel: readyAppModel() as any,
    catalog: [
      { type: 'spill', stageId: 1, impactBand: 'warning', recommendation: 'Fix spill.' },
      { type: 'coreLocality', stageId: null, impactBand: 'critical', value: 40, recommendation: 'Check locality.', nonLocalTaskCount: 0 },
      ...verdictLeads(),
    ],
  });
  render(<App />);
  await waitForDashboard();

  await user.click(screen.getByRole('button', { name: '1 critical: show them in Findings' }));

  expect(screen.getByText('Cleared the spill filter to show the critical findings.')).toHaveAttribute('role', 'status');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Critical' })));
  expect(new URLSearchParams(window.location.search).get('type')).toBeNull();
});

test('the top bar count chip still lands when the filter empties the board', async () => {
  const user = userEvent.setup();
  window.history.replaceState({}, '', '/?impact=info');
  store.setState({
    status: 'ready', appModel: readyAppModel() as any,
    catalog: [{ type: 'skew', stageId: 1, impactBand: 'critical', recommendation: 'Fix skew.' }, ...verdictLeads('critical')],
  });
  render(<App />);
  const chip = await screen.findByRole('button', { name: '4 critical: show them in Findings' });
  expect(screen.queryByRole('tab', { name: 'Findings' })).not.toBeInTheDocument();

  await user.click(chip);

  expect(screen.getByText('Cleared the info impact filter to show the critical findings.')).toBeInTheDocument();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Critical' })));
});

test('in Basic view, a route that clears the last active filter hides the bar and its notice together', async () => {
  const user = userEvent.setup();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  window.history.replaceState({}, '', '/?impact=info');
  store.setState({
    status: 'ready', appModel: readyAppModel() as any, widgetDensity: 'basic',
    catalog: [
      { type: 'skew', stageId: 1, impactBand: 'critical', recommendation: 'Fix skew.', impactEstimate: { basis: 'serial', wallClock: { low: 9_000, high: 9_000 }, estimateMethod: 'modeled' } },
      { type: 'skew', stageId: 2, impactBand: 'critical', recommendation: 'Fix more skew.', impactEstimate: { basis: 'serial', wallClock: { low: 8_000, high: 8_000 }, estimateMethod: 'modeled' } },
      { type: 'spill', stageId: 3, impactBand: 'info', recommendation: 'Fix spill.' },
    ],
  });
  render(<App />);
  await waitForDashboard();
  expect(screen.getByRole('region', { name: 'Filter findings' })).toBeInTheDocument();

  // The second skew step shares the first step's card, so it routes there and clears the impact filter.
  const secondStep = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step')[1];
  await user.click(within(secondStep).getByRole('button', { name: /show evidence/i }));

  expect(new URLSearchParams(window.location.search).get('impact')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Filter findings' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Cleared the info impact filter/)).not.toBeInTheDocument();
  // @ts-expect-error -- restore jsdom's default (no scrollIntoView)
  delete Element.prototype.scrollIntoView;
});

test('the verdict links to the rest with the Findings tab\'s count when each place has a second finding', async () => {
  store.setState({
    status: 'ready', appModel: readyAppModel() as any,
    catalog: [
      ...verdictLeads(),
      ...[3, 4, 5].map((stageId) => ({ type: 'spill', stageId, impactBand: 'warning', recommendation: 'Fix spill.' }) as Finding),
    ],
  });
  render(<App />);
  await waitForDashboard();

  const verdict = screen.getByTestId('run-verdict');
  expect(within(verdict).getAllByTestId('next-step')).toHaveLength(3);
  expect(within(verdict).getByRole('button', { name: 'More findings (3)' })).toBeInTheDocument();
  expect(screen.getByTestId('more-findings-heading')).toHaveTextContent('More findings (3)');
});
