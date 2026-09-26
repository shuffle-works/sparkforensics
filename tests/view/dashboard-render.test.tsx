// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '@/App';
import { auditConfig } from '@sparkforensics/core/analyzer.ts';
import { store, emptyAppModel } from '@/store/store';
import type { Finding } from '@sparkforensics/core/types.ts';

function CriticalAlert() {
  return <h3>Critical alert</h3>;
}

function WarningAlert() {
  return <h3>Warning alert</h3>;
}

function InfoAlert() {
  return <h3>Info alert</h3>;
}

function CleanAlert() {
  return <h3>Clean alert</h3>;
}

// Mock orderedWidgets() to return real widgets (one per region) so this test
// exercises the actual region-routing/prop-threading against real output.
// Reuse actual.REGISTRY.*.component (not direct imports) so the returned
// component stays referentially identical to REGISTRY's: Alerts.tsx's
// typesByComponent map looks up findings by that exact object identity.
vi.mock('@/view/detector-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/view/detector-registry')>();
  return {
    ...actual,
    REGISTRY: {
      ...actual.REGISTRY,
      criticalAlert: { component: CriticalAlert, region: 'action' as const, widgetId: 'critical-alert', widgetTitle: 'Critical alert', findingLabel: 'critical alert', routeable: false },
      warningAlert: { component: WarningAlert, region: 'action' as const, widgetId: 'warning-alert', widgetTitle: 'Warning alert', findingLabel: 'warning alert', routeable: false },
      infoAlert: { component: InfoAlert, region: 'action' as const, widgetId: 'info-alert', widgetTitle: 'Info alert', findingLabel: 'info alert', routeable: false },
      cleanAlert: { component: CleanAlert, region: 'action' as const, widgetId: 'clean-alert', widgetTitle: 'Clean alert', findingLabel: 'clean alert', routeable: false },
    },
    orderedWidgets: () => [
      { component: actual.REGISTRY.spill.component, region: 'action' as const, widgetId: 'spill', widgetTitle: 'Spill', findingLabel: 'spill', type: 'spill' },
      { component: actual.REGISTRY.skew.component, region: 'action' as const, widgetId: 'skew', widgetTitle: 'Task Skew', findingLabel: 'task skew', type: 'skew' },
      { component: CriticalAlert, region: 'action' as const, widgetId: 'critical-alert', widgetTitle: 'Critical alert', findingLabel: 'critical alert', type: 'criticalAlert' },
      { component: WarningAlert, region: 'action' as const, widgetId: 'warning-alert', widgetTitle: 'Warning alert', findingLabel: 'warning alert', type: 'warningAlert' },
      { component: InfoAlert, region: 'action' as const, widgetId: 'info-alert', widgetTitle: 'Info alert', findingLabel: 'info alert', type: 'infoAlert' },
      { component: CleanAlert, region: 'action' as const, widgetId: 'clean-alert', widgetTitle: 'Clean alert', findingLabel: 'clean alert', type: 'cleanAlert' },
      { component: actual.REGISTRY.configAudit.component, region: 'action' as const, widgetId: 'config-audit', widgetTitle: 'Config Sanity', findingLabel: 'config audit', type: 'configAudit' },
      // memoryUtilization is always-mounted, so this entry is filtered out of
      // componentWidgets and reaches the DOM via Alerts.tsx's reference grid instead.
      { component: actual.REGISTRY.memoryUtilization.component, region: 'reference' as const, widgetId: 'memory-utilization', widgetTitle: 'Memory Utilization', findingLabel: 'memory utilization', type: 'memoryUtilization' },
    ],
  };
});

function readyAppModel() {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 3600000, resources: { executor: { cores: 4, memory: '4g' }, driver: { memory: '2g', cores: 1 } } },
    stages: new Map([
      [1, { id: 1, parentIds: [], submittedAt: 0, completedAt: 1800000, inputBytes: 1000, shuffleReadBytes: 0, shuffleWriteBytes: 500, outputBytes: 0 }],
      [2, { id: 2, parentIds: [1], submittedAt: 1800000, completedAt: 3600000, inputBytes: 0, shuffleReadBytes: 500, shuffleWriteBytes: 0, outputBytes: 1000 }],
    ]),
    executors: { added: [{ executorId: '1', timestamp: 0, totalCores: 4 }], removed: [] },
    runAggregates: {
      busyCoreMs: 2_700_000,
      perStage: {
        1: { totalTaskDurationSum: 900_000, taskCount: 4 },
        2: { totalTaskDurationSum: 1_800_000, taskCount: 4 },
      },
    },
  };
}

async function waitForDashboard() {
  return screen.findByRole('tab', { name: 'Findings' });
}

// A row's stable selector is its data-finding-type; a type firing more than
// once collapses into a group row.
function hasFixTheseFirstRow(type: string) {
  return screen.queryAllByTestId('fix-these-first-row').some((row) => row.dataset.findingType === type)
    || screen.queryAllByTestId('fix-these-first-group-row').some((row) => row.dataset.findingType === type);
}

beforeEach(() => {
  store.setState({
    appModel: emptyAppModel(),
    catalog: [],
    configFindings: [],
    status: 'idle',
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
    widgetDensity: 'basic',
  });
});

/** Card-placement tests need every band's evidence cards mounted: Advanced
 * view shows them, Basic view folds them per band (triage-navigation.test.tsx
 * covers the fold). */
function showAllEvidence() {
  store.setState({ widgetDensity: 'advanced' });
}

test('the Findings tab shows every REGISTRY widget with findings, while Full app report starts unselected', async () => {
  showAllEvidence();
  const user = userEvent.setup();
  const catalog: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'warning', value: 123 },
    { type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'info', value: 0.4 },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog });

  render(<App />);
  await waitForDashboard();

  const findingsPanel = screen.getByRole('tabpanel', { name: 'Findings' });
  // Spill/Memory Utilization are code-split, so their headings resolve async;
  // both need their active finding to mount.
  expect(await within(findingsPanel).findByRole('heading', { name: 'Spill' })).toBeInTheDocument();
  expect(await within(findingsPanel).findByRole('heading', { name: 'Memory Utilization' })).toBeInTheDocument();

  const reportTab = screen.getByRole('tab', { name: 'Full app report' });
  expect(reportTab).toHaveAttribute('aria-selected', 'false');
  expect(screen.queryByRole('tabpanel', { name: 'Full app report' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /clean checks/i })).toHaveAttribute('aria-expanded', 'false');

  // Stage Summary lives inside Full app report, not the Findings tab.
  expect(within(findingsPanel).queryByRole('heading', { name: 'Stage Summary' })).not.toBeInTheDocument();

  await user.click(reportTab);
  const reportPanel = screen.getByRole('tabpanel', { name: 'Full app report' });
  expect(within(reportPanel).getByRole('heading', { name: 'Stage Summary' })).toBeInTheDocument();
  // REGISTRY widgets only mount in ImpactBoard (Findings tab), never in Full app report.
  expect(within(reportPanel).queryByRole('heading', { name: 'Memory Utilization' })).not.toBeInTheDocument();
  expect(within(reportPanel).queryByRole('heading', { name: 'Spill' })).not.toBeInTheDocument();
});

test('Findings impact-band-ranks affected widgets into Critical/Warning/Info bands and moves clean widgets behind Clean checks', async () => {
  showAllEvidence();
  const user = userEvent.setup();
  const catalog: Finding[] = [
    { type: 'infoAlert', stageId: 1, impactBand: 'info' },
    { type: 'warningAlert', stageId: 1, impactBand: 'warning' },
    { type: 'criticalAlert', stageId: 1, impactBand: 'critical' },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog });

  render(<App />);
  await waitForDashboard();

  const findingsPanel = screen.getByRole('tabpanel', { name: 'Findings' });
  // Core Usage by Locality is the one remaining always-mounted reference
  // widget and is code-split; wait for it before asserting the heading list.
  // Memory/Executor Utilization and Cache Storage are not always-mounted, so
  // they're absent from this catalog-less run.
  await within(findingsPanel).findByRole('heading', { name: 'Core Usage by Locality' });
  expect(within(findingsPanel).getAllByRole('heading').map((node) => node.textContent))
    .toEqual([
      'Findings',
      'Critical', 'Critical alert',
      'Warning', 'Warning alert',
      'Info', 'Info alert',
      'Core Usage by Locality',
      'Clean checks',
    ]);
  // Clean widgets render a CleanCheckRow, not their real component, so there is no "Clean alert" heading.
  expect(within(findingsPanel).queryByRole('heading', { name: 'Clean alert' })).not.toBeInTheDocument();
  expect(within(findingsPanel).queryByRole('heading', { name: 'Cache Storage' })).not.toBeInTheDocument();
  expect(within(findingsPanel).queryByRole('heading', { name: 'Memory Utilization' })).not.toBeInTheDocument();
  expect(within(findingsPanel).queryByRole('heading', { name: 'Executor Utilization' })).not.toBeInTheDocument();
  expect(screen.queryByText('clean alert')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /clean checks/i }));
  expect(screen.queryByRole('heading', { name: 'Clean alert' })).not.toBeInTheDocument();
  expect(screen.getByText('Clean alert')).toBeInTheDocument();
  // Cache Storage, Memory Utilization, and Executor Utilization all have no
  // finding here, so each shows as an ordinary Clean-checks row (the row
  // label itself still comes from the finding-type name).
  expect(screen.getByText('Cache utilization')).toBeInTheDocument();
  expect(screen.getByText('Memory utilization')).toBeInTheDocument();
  expect(screen.getByText('Executor utilization')).toBeInTheDocument();
});

test('a clean type still gets its own clean-check line when a sibling sharing its chart component is active', async () => {
  showAllEvidence();
  // skew/tinyTask/stageShape used to share the TaskSkew component (now each
  // has its own: Skew/StageShape/TinyTask); kept as a regression guard that
  // an active skew finding must not swallow the other two's clean-check lines.
  const user = userEvent.setup();
  const catalog: Finding[] = [
    { type: 'skew', stageId: 1, impactBand: 'warning' },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog });

  render(<App />);
  await waitForDashboard();

  const findingsPanel = screen.getByRole('tabpanel', { name: 'Findings' });
  expect(await within(findingsPanel).findByRole('heading', { name: 'Task Skew' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /clean checks/i }));
  expect(screen.getByText('Tiny tasks')).toBeInTheDocument();
  expect(screen.getByText('Stage shape')).toBeInTheDocument();
});

test('empty catalog shows the "no findings to fix" empty state alongside the always-visible grid and the Full app report tab', async () => {
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog: [] });

  render(<App />);
  await waitForDashboard();

  expect(screen.getByText(/no findings to fix/i)).toBeInTheDocument();
  // The empty state is additive: the always-visible grid and Full app report remain available.
  expect(await screen.findByRole('heading', { name: 'Core Usage by Locality' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Full app report' })).toBeInTheDocument();
});

test('shows real Config Audit findings as a row in All recommendations without adding them to the catalog', async () => {
  const appModel = readyAppModel() as any;
  appModel.app = {
    ...appModel.app,
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  };
  // configFindings is computed at ingest, not by Dashboard; seed it as runDone would.
  store.setState({ status: 'ready', appModel: appModel as any, catalog: [], configFindings: auditConfig(appModel.app) });

  render(<App />);
  await waitForDashboard();

  // configAudit is action-region: it renders a row in All recommendations, not the empty state.
  expect(screen.queryByText(/no findings to fix/i)).not.toBeInTheDocument();
  expect(hasFixTheseFirstRow('configAudit')).toBe(true);
});

test('Config Audit ranks by its real impact band inside Suggested Improvements, not Clean checks', async () => {
  showAllEvidence();
  const user = userEvent.setup();
  const appModel = readyAppModel() as any;
  appModel.app = {
    ...appModel.app,
    config: {},
    resources: { dynamicAllocationEnabled: false, shuffleServiceEnabled: false },
  };
  const configFindings: Finding[] = [
    { type: 'configAudit', property: 'spark.shuffle.service.enabled', stageId: null, impactBand: 'critical', recommendation: 'Enable the shuffle service.' },
  ];
  store.setState({ status: 'ready', appModel, catalog: [], configFindings });

  render(<App />);
  await waitForDashboard();

  const findingsPanel = screen.getByRole('tabpanel', { name: 'Findings' });
  // Config Sanity is code-split (React.lazy); its chunk resolves asynchronously.
  expect(await within(findingsPanel).findByRole('heading', { name: 'Config Sanity' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /clean checks/i }));
  expect(within(findingsPanel).queryByText('Config Sanity', { selector: '[data-testid^="clean-alert"] h3' })).not.toBeInTheDocument();
});

test('reads configFindings from the store rather than recomputing it from appModel.app', async () => {
  // readyAppModel has no config/resources, so recomputing auditConfig would yield [].
  // Seeding configFindings with a finding it could never produce proves Dashboard
  // reads the slice, not the function.
  const configFindings: Finding[] = [
    { type: 'configAudit', property: 'spark.serializer', impactBand: 'info', recommendation: 'x', stageId: null },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog: [], configFindings });

  render(<App />);
  await waitForDashboard();

  expect(hasFixTheseFirstRow('configAudit')).toBe(true);
});

test('the dashboard heading outline nests correctly: one h1, h2 sections (including impact bands), h3 widget titles', async () => {
  showAllEvidence();
  const user = userEvent.setup();
  const catalog: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'warning', value: 123 },
    { type: 'memoryUtilization', variant: 'idleCores', stageId: null, impactBand: 'info', value: 0.4 },
  ];
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog });

  render(<App />);
  await waitForDashboard();
  // Spill needs its finding's impact band to resolve before its heading joins
  // the outline. Full app report's keepMounted panel stays out of the tree
  // (native hidden) until selected.
  await screen.findByRole('heading', { name: 'Spill' });

  // Exactly one page title.
  expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent))
    .toEqual(['SparkForensics']);

  // The run verdict, the Findings heading and each active impact band sit at
  // level 2 (bands are board-level sections, not nested under Findings). Full
  // app report's level-2 heading joins the outline only once selected. Neither
  // finding carries a recommendation, so the verdict has no step to lead with.
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent))
    .toEqual(['2 findings to review', 'Findings', 'Warning', 'Info']);

  // Widget titles nest one level below their impact band.
  expect(await screen.findByRole('heading', { name: 'Spill', level: 3 })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Warning', level: 2 })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Memory Utilization', level: 3 })).toBeInTheDocument();

  // Select Full app report: its own sr-only level-2 heading and Stage
  // Summary's level-3 heading join the outline once its panel mounts.
  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  expect(screen.getByRole('heading', { name: 'Full app report', level: 2 })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Stage Summary', level: 3 })).toBeInTheDocument();

  // Walking the outline in document order never skips a level downward.
  const levels = screen.getAllByRole('heading')
    .map((h) => Number(h.tagName.slice(1)));
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  }
});

test('switching Findings <-> Full app report keeps an expanded finding group open', async () => {
  // Both panels are keepMounted (hidden, not unmounted) so a round trip through
  // Full app report doesn't reset ImpactBoard's local expandedGroupKey state.
  const user = userEvent.setup();
  const appModel = readyAppModel() as any;
  appModel.stages = new Map([
    [1, { id: 1, submittedAt: 0, completedAt: 1000 }],
    [2, { id: 2, submittedAt: 0, completedAt: 1000 }],
  ]);
  const catalog: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'warning', value: 123 },
    { type: 'spill', stageId: 2, impactBand: 'warning', value: 456 },
  ];
  store.setState({ status: 'ready', appModel, catalog });

  render(<App />);
  await waitForDashboard();

  // Two spill findings roll up into one collapsible group row rather than
  // two individual rows.
  const groupRow = await screen.findByTestId('fix-these-first-group-row');
  const toggle = within(groupRow).getByRole('button');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  await user.click(screen.getByRole('tab', { name: 'Findings' }));

  expect(within(screen.getByTestId('fix-these-first-group-row')).getByRole('button'))
    .toHaveAttribute('aria-expanded', 'true');
});

test('Reference-section grid items render with collapsedTile', async () => {
  const user = userEvent.setup();
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog: [] });

  render(<App />);
  await waitForDashboard();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));

  // All six Reference-section widgets should render with collapsedTile class.
  // collapsedTile makes the card start collapsed with a fixed min height.
  const referenceWidgets = [
    'Evidence availability',
    'ETL Phase Attribution',
    'What-If Executor Scaling',
    'Compute Efficiency',
    'Wasted Core-Hours',
    'Core-Usage Distribution',
  ];

  for (const widgetTitle of referenceWidgets) {
    const heading = await screen.findByRole('heading', { name: widgetTitle });
    const card = heading.closest('[data-slot="card"]');
    expect(card).toHaveClass('min-h-[6.5rem]');
  }
});

test('the first Tab stop skips past the top bar to the verdict', async () => {
  const user = userEvent.setup();
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog: [], configFindings: [] });
  render(<App />);
  await waitForDashboard();

  await user.tab();
  expect(document.activeElement).toHaveTextContent('Skip to the verdict');
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(screen.getByTestId('run-verdict'));
});

test('the top bar count chip opens Findings on the band it counts', async () => {
  const user = userEvent.setup();
  const skew: Finding = { type: 'skew', stageId: 1, impactBand: 'warning', recommendation: 'Rebalance Stage 1.' };
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog: [skew], configFindings: [] });
  render(<App />);
  await waitForDashboard();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  await user.click(screen.getByRole('button', { name: '1 warning: show them in Findings' }));
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Warning' })));
});
