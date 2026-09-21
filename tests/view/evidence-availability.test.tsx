// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { auditConfig } from '@sparkforensics/core/analyzer.ts';
import type { EvidenceAvailability } from '@sparkforensics/core/types.ts';
import { store, emptyAppModel } from '@/store/store';
import { Dashboard } from '@/view/Dashboard';
import { EvidenceAvailability as EvidenceAvailabilityWidget } from '@/view/widgets/EvidenceAvailability';
import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider, useEvidenceAvailabilityNavigation } from '@/view/EvidenceAvailabilityContext';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { ThemeProvider } from '@/theme/ThemeProvider';

const presentLedger: EvidenceAvailability = {
  schemaVersion: 1,
  entries: [
    { key: 'executorMetrics', state: 'present', reasonCode: 'observed', summary: 'Observed in this event log.', evidence: { eventType: 'executorMetricRows', count: 12 } },
    { key: 'rddStorageSnapshots', state: 'disabled', reasonCode: 'explicitlyDisabled', summary: 'Explicitly disabled in this event log.' },
    { key: 'sqlPlan', state: 'notEmitted', reasonCode: 'noResolvedSqlPlan', summary: 'Not emitted by this event log.' },
    { key: 'sparkConfiguration', state: 'notApplicable', reasonCode: 'noSqlExecution', summary: 'Not applicable to this event log.' },
    { key: 'taskCoreTime', state: 'outsideEventLog', reasonCode: 'outsideEventLogScope', summary: 'Available outside local event-log scope.' },
    { key: 'infrastructureContext', state: 'unknown', reasonCode: 'parseIncomplete', summary: 'Cannot determine from an incomplete parse.' },
    { key: 'sourceContext', state: 'present', reasonCode: 'observed', summary: 'Observed in this event log.' },
    { key: 'costContext', state: 'present', reasonCode: 'observed', summary: 'Observed in this event log.' },
  ],
};

function readyModel(evidenceAvailability: EvidenceAvailability | null = presentLedger) {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 60_000 },
    evidenceAvailability,
  };
}

function renderDashboard() {
  return render(
    <ThemeProvider>
      <DocsProvider>
        <StageDetailProvider>
          <Dashboard />
        </StageDetailProvider>
      </DocsProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  store.setState({
    ...store.getState(),
    appModel: readyModel(),
    catalog: [],
    status: 'ready',
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
  });
});

afterEach(() => {
  store.getState().setWidgetDensity('basic');
});

test('keeps the Full app report tab initially unselected and renders every ledger category once opened', async () => {
  const user = userEvent.setup();
  renderDashboard();

  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'false');
  expect(screen.queryByRole('heading', { name: 'Evidence availability' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));

  // The card itself starts collapsed (a uniform Reference-grid tile); open it
  // before checking the ledger rows.
  await user.click(screen.getByRole('button', { name: 'Evidence availability' }));

  const card = screen.getByRole('heading', { name: 'Evidence availability' }).closest('[data-slot="card"]') as HTMLElement;
  expect(within(card).getAllByRole('listitem')).toHaveLength(8);
  expect(within(card).getAllByText('present')[0]).toBeVisible();
  expect(within(card).getByText('disabled')).toBeVisible();
  expect(within(card).getByText('not emitted')).toBeVisible();
  expect(within(card).getByText('not applicable')).toBeVisible();
  expect(within(card).getByText('outside event log')).toBeVisible();
  expect(within(card).getByText('unknown')).toBeVisible();
  // Summary + count live in the row tooltip so each cell stays one line.
  expect(within(card).getByTitle(/12 observed/)).toBeVisible();
  expect(card).not.toHaveClass('border-critical', 'border-warning', 'border-info');
});

test('renders a terse unavailable card when a legacy model has no ledger', async () => {
  const user = userEvent.setup();
  store.setState({ ...store.getState(), appModel: readyModel(null) });
  renderDashboard();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  expect(screen.getByRole('heading', { name: 'Evidence availability' })).toBeVisible();

  // The card itself starts collapsed (a uniform Reference-grid tile); open it
  // before checking the body copy.
  await user.click(screen.getByRole('button', { name: 'Evidence availability' }));
  expect(screen.getByText(/evidence availability is unavailable for this restored run/i)).toBeVisible();
});

test('Memory Utilization finding opens executor-metrics evidence', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  store.setState({
    ...store.getState(),
    // An ordinary (non-dataUnavailable) row: the dataUnavailable placeholder
    // no longer carries its own evidence pill (it would be circular, its
    // whole content IS the "evidence unavailable" note).
    catalog: [{
      type: 'memoryUtilization', variant: 'memoryBand', stageId: null, executorId: '3', impactBand: 'info',
      recommendation: 'Executor 3 used only 20% of allocated heap: memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.',
    }],
  });
  renderDashboard();

  // Memory Utilization is code-split (React.lazy); its chunk resolves async.
  await screen.findByRole('heading', { name: /^memory utilization$/i });
  // The widget card starts collapsed; open it before reaching the evidence
  // link in its body.
  await user.click(screen.getByRole('button', { name: 'Memory Utilization' }));
  await user.click(screen.getByRole('button', { name: /evidence: executor metrics/i }));

  expect(document.activeElement).toBe(document.getElementById('evidence-availability-executorMetrics'));
  expect(document.activeElement).toHaveClass('focus:ring-2');
});

test('Redundant Plan Subtree finding opens SQL-plan evidence with keyboard activation', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  store.setState({
    ...store.getState(),
    catalog: [{
      type: 'duplicatePlanSubtree', stageId: null, impactBand: 'warning', stageIds: [1],
      recommendation: 'Consider caching the shared computation.',
    }],
  });
  renderDashboard();

  // Redundant Plan Subtree is code-split (React.lazy); its chunk resolves async.
  await screen.findByRole('heading', { name: /^redundant plan subtree$/i });
  // The widget card starts collapsed; the evidence control (RowStatusCluster)
  // lives in the card body, so open it first.
  await user.click(screen.getByRole('button', { name: 'Redundant Plan Subtree' }));
  const link = screen.getByRole('button', { name: /^evidence: sql plan$/i });
  link.focus();
  await user.keyboard('{Enter}');

  expect(document.activeElement).toBe(document.getElementById('evidence-availability-sqlPlan'));
});

test('Config Audit finding switches to the Full app report tab before focusing its ledger entry', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const app = {
    startTime: 0,
    endTime: 60_000,
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  };
  store.setState({
    ...store.getState(),
    appModel: { ...readyModel(), app },
    configFindings: auditConfig(app),
  });
  renderDashboard();

  // A clean widget renders only a plain CleanCheckRow, so a real finding is
  // needed to reach the evidence link. Config Sanity is code-split (React.lazy).
  await screen.findByRole('heading', { name: /^config sanity$/i });
  // The widget card starts collapsed; the evidence control (RowStatusCluster)
  // lives in the card body, so open it before clicking it. Clicking the
  // evidence link then switches to the Full app report tab (where the
  // ledger lives) and focuses the entry in one step.
  await user.click(screen.getByRole('button', { name: 'Config Sanity' }));
  await user.click(screen.getAllByRole('button', { name: /^evidence: spark configuration$/i })[0]);

  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'true');
  expect(document.activeElement).toBe(document.getElementById('evidence-availability-sparkConfiguration'));
});

test('Redundant Plan Subtree finding opens SQL-plan evidence', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  store.setState({
    ...store.getState(),
    catalog: [{
      type: 'duplicatePlanSubtree', stageId: null, impactBand: 'warning', stageIds: [1],
      recommendation: 'Consider caching the shared computation.',
    }],
  });
  renderDashboard();

  // Redundant Plan Subtree is code-split (React.lazy); its chunk resolves async.
  await screen.findByRole('heading', { name: /^redundant plan subtree$/i });
  // The widget card starts collapsed; the evidence control (RowStatusCluster)
  // lives in the card body, so open it first.
  await user.click(screen.getByRole('button', { name: 'Redundant Plan Subtree' }));
  await user.click(screen.getByRole('button', { name: /^evidence: sql plan$/i }));

  expect(document.activeElement).toBe(document.getElementById('evidence-availability-sqlPlan'));
});

test('Config Audit finding opens Spark-configuration evidence', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const app = {
    startTime: 0,
    endTime: 60_000,
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  };
  store.setState({
    ...store.getState(),
    appModel: { ...readyModel(), app },
    configFindings: auditConfig(app),
  });
  renderDashboard();

  // A clean widget renders only a plain CleanCheckRow, so a real finding is
  // needed to reach the evidence link. Config Sanity is code-split (React.lazy).
  await screen.findByRole('heading', { name: /^config sanity$/i });
  // The widget card starts collapsed; the evidence control (RowStatusCluster)
  // lives in the card body, so open it first.
  await user.click(screen.getByRole('button', { name: 'Config Sanity' }));
  await user.click(screen.getAllByRole('button', { name: /^evidence: spark configuration$/i })[0]);

  expect(document.activeElement).toBe(document.getElementById('evidence-availability-sparkConfiguration'));
});

test('unavailable ScalingSim opens task-and-core-time evidence', async () => {
  const user = userEvent.setup();
  store.setState({
    ...store.getState(),
    appModel: {
      ...readyModel(),
      evidenceAvailability: {
        ...presentLedger,
        entries: presentLedger.entries.map((entry) => entry.key === 'taskCoreTime'
          ? { key: 'taskCoreTime', state: 'notEmitted' as const, reasonCode: 'noUsableCoreTimeAggregate' as const, summary: 'No usable aggregate was emitted.' }
          : entry),
      },
    },
  });
  renderDashboard();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));

  // The What-If Executor Scaling widget card starts collapsed; the evidence
  // control (RowStatusCluster) lives in the card body, so open it first.
  await screen.findByRole('heading', { name: /^what-if executor scaling$/i });
  await user.click(screen.getByRole('button', { name: 'What-If Executor Scaling' }));
  await user.click(screen.getByRole('button', { name: /evidence: task and core time/i }));

  expect(document.activeElement).toBe(document.getElementById('evidence-availability-taskCoreTime'));
});

test('opens and focuses the evidence card when revealEvidence is triggered from a collapsed state', async () => {
  const user = userEvent.setup();

  // Standalone caller of the shared navigation hook, mirroring how a finding
  // widget's evidence link (RowStatusCluster) triggers revealEvidence.
  function RevealButton() {
    const { revealEvidence } = useEvidenceAvailabilityNavigation();
    return <button onClick={() => revealEvidence('sparkConfiguration')}>Reveal</button>;
  }

  render(
    <EvidenceAvailabilityProvider>
      <RevealButton />
      <EvidenceAvailabilityWidget ledger={presentLedger} />
    </EvidenceAvailabilityProvider>,
  );

  // The provider starts collapsed (`evidenceCardOpen` defaults to false).
  expect(screen.getByRole('button', { name: /evidence availability/i })).toHaveAttribute('aria-expanded', 'false');

  await user.click(screen.getByRole('button', { name: 'Reveal' }));

  expect(screen.getByRole('button', { name: /evidence availability/i })).toHaveAttribute('aria-expanded', 'true');
  expect(document.activeElement).toBe(document.getElementById('evidence-availability-sparkConfiguration'));
});

test('the evidence detail sentence is inline text at Advanced tier, hover-only at Basic', () => {
  store.getState().setWidgetDensity('basic');
  const ledger: EvidenceAvailability = {
    schemaVersion: 1,
    entries: [
      { key: 'sparkConfiguration', state: 'present', reasonCode: 'observed', summary: 'Config captured', evidence: { eventType: 'executorMetricRows', count: 3 } },
    ],
  };
  render(<EvidenceAvailabilityWidget ledger={ledger} />);
  // At Basic tier, detail is hover-only via title attribute, not visible as inline text
  const basicItem = screen.getByRole('listitem');
  const visibleSpans = within(basicItem).queryAllByText(/config captured.*3 observed/i);
  // Only sr-only and title should have the detail, not a visible span
  expect(visibleSpans.every((s) => s.className.includes('sr-only'))).toBe(true);

  cleanup();
  store.getState().setWidgetDensity('advanced');
  render(<EvidenceAvailabilityWidget ledger={ledger} />);
  // At Advanced tier, detail is visible as inline text
  const advancedItem = screen.getByRole('listitem');
  const visibleDetailSpans = within(advancedItem).queryAllByText(/config captured.*3 observed/i);
  // Should have both sr-only and visible span; verify at least one is visible
  expect(visibleDetailSpans.some((s) => !s.className.includes('sr-only'))).toBe(true);
  store.getState().setWidgetDensity('basic');
});
