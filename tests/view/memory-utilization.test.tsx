// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryUtilization } from '../../src/view/widgets/MemoryUtilization';
import { EvidenceAvailabilityProvider } from '../../src/view/EvidenceAvailabilityContext';
import { DocsProvider } from '../../src/view/DocsContext';
import { store } from '../../src/store/store';
import type { Finding } from '@sparkforensics/core/types.ts';

test('renders nothing when there are no memoryUtilization findings (collapses to a Clean-checks row instead)', () => {
  const { container } = render(<MemoryUtilization catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders nothing when the only memoryUtilization finding is the dataUnavailable caveat', () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'memoryBand', stageId: null,
      impactBand: 'info', metric: 'memoryBand', dataUnavailable: true,
      recommendation: 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true: not enabled for this run.',
    },
  ];
  // Not real evidence of an issue (the fact already lives in the Evidence
  // availability ledger), so this collapses like a genuinely clean run.
  const { container } = render(<MemoryUtilization catalog={catalog} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading, MEM badge, and every affected variant (not just the worst), with every recommendation always visible at Basic tier', async () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null,
      impactBand: 'warning', metric: 'idleCoreRate', value: 75,
      recommendation: 'Over half of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.',
    },
    {
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity', stageId: null, executorId: '3',
      impactBand: 'warning', metric: 'heapUsedRatio', value: 98,
      recommendation: 'Executor 3 peaked at 98% of allocated heap: memory may be too small; raise spark.executor.memory to avoid OOM/spill.',
    },
    {
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned', stageId: null, executorId: '7',
      impactBand: 'info', metric: 'heapUsedRatio', value: 20,
      recommendation: 'Executor 7 used only 20% of allocated heap: memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.',
    },
    {
      type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
      impactBand: 'info', metric: 'wastedMBSeconds', value: 12345,
      confidence: 'low',
      recommendation: 'Allocated executor memory sat largely idle over the run: review spark.executor.memory and executor count.',
    },
  ];

  // No density set: defaults to Basic. The advice half of every recommendation
  // must already be visible here, unlike the diagnosis clause asserted below.
  const { unmount } = render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);

  expect(screen.getByRole('heading', { name: 'Memory Utilization' })).toBeInTheDocument();
  expect(screen.getByText('MEM')).toBeInTheDocument();

  // Collapsed labels are visible without expanding any row.
  expect(screen.getByText('Idle cores', { exact: false })).toBeInTheDocument();
  expect(screen.getByText('Memory waste', { exact: false })).toBeInTheDocument();

  // Recommendation text is visible for every row without expanding anything,
  // and without switching density. Only the advice half is asserted: the
  // leading clause restates memoryDetail's own figure (e.g. "98% of allocated
  // heap used: near capacity"), so it's extended rather than repeated
  // verbatim (see memoryAction).
  expect(screen.getByText(/reduce cluster size or enable dynamic allocation/)).toBeInTheDocument();
  expect(screen.getByText(/memory may be too small; raise spark\.executor\.memory to avoid OOM\/spill/)).toBeInTheDocument();
  expect(screen.getByText(/memory may be over-provisioned; consider reducing spark\.executor\.memory for cost savings/)).toBeInTheDocument();
  expect(screen.getByText(/review spark\.executor\.memory and executor count/)).toBeInTheDocument();
  // The heapNearCapacity/heapOverProvisioned diagnosis clause is redundant
  // with memoryDetail() and stays Advanced-only.
  expect(screen.queryByText(/Executor 3 peaked at 98% of allocated heap\./)).not.toBeInTheDocument();
  expect(screen.queryByText(/Executor 7 used only 20% of allocated heap\./)).not.toBeInTheDocument();
  unmount();

  store.getState().setWidgetDensity('advanced');
  render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);
  // At Advanced tier the diagnosis clause for the two rule-discriminated rows
  // becomes visible too, alongside the advice that was already shown at Basic.
  expect(screen.getAllByText(/Executor 3 peaked at 98% of allocated heap\./).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Executor 7 used only 20% of allocated heap\./).length).toBeGreaterThan(0);

  // Sorted worst-first: idleCores(warning), executor3(warning), executor7(info), wasteModel(info).
  // The evidence marker lives on the widget header, once, not per row.
  expect(screen.getByRole('button', { name: /^evidence: executor metrics$/i })).toBeInTheDocument();
  // The wasteModel row is the only one of the four carrying a `confidence`;
  // since the group disagrees, the header omits a confidence claim rather
  // than applying one finding's confidence to the whole widget.
  expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('the header MEM badge links to the docs anchor for memoryUtilization findings (no separate "Learn more" link)', () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null,
      impactBand: 'warning', metric: 'idleCoreRate', value: 75,
      recommendation: 'Over half of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.',
    },
  ];
  render(
    <DocsProvider>
      <MemoryUtilization catalog={catalog} defaultCollapsed={false} />
    </DocsProvider>,
  );

  expect(screen.queryByRole('link', { name: /learn more/i })).not.toBeInTheDocument();
  const badgeLinks = screen.getAllByRole('link', { name: 'MEM' });
  expect(badgeLinks.length).toBeGreaterThan(0);
  for (const link of badgeLinks) expect(link.getAttribute('href')).toContain('#bottleneck-memory-utilization');
});

test('shows a low-confidence caveat for the waste-model finding', async () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
      impactBand: 'info', metric: 'wastedMBSeconds', value: 12345,
      confidence: 'low',
      validationRequired: 'Memory-waste estimate uses allocated-vs-used memory-time and a 1.5x buffer: confirm against the Spark UI before acting.',
      recommendation: 'Allocated executor memory sat largely idle over the run: review spark.executor.memory and executor count.',
    },
  ];

  store.getState().setWidgetDensity('advanced');
  render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);

  const caveat = screen.getByText(/low confidence/i);
  expect(caveat).toBeInTheDocument();
  expect(caveat).toHaveAttribute(
    'title',
    'Memory-waste estimate uses allocated-vs-used memory-time and a 1.5x buffer: confirm against the Spark UI before acting.',
  );
  store.getState().setWidgetDensity('basic');
});

test('shows a muted data-unavailable note with no bold label, impact dot, or evidence pill', async () => {
  // A dataUnavailable-only catalog no longer mounts this widget at all (see
  // "renders nothing when there are no memoryUtilization findings" below), so
  // this needs a real accompanying finding to exercise the dataUnavailable
  // row's own rendering.
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null,
      impactBand: 'warning', metric: 'idleCoreRate', value: 75,
      recommendation: 'Over half of allocated core-time ran no task.',
    },
    {
      type: 'memoryUtilization', variant: 'memoryBand', stageId: null,
      impactBand: 'info', metric: 'memoryBand', dataUnavailable: true,
      recommendation: 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true: not enabled for this run.',
    },
  ];

  store.getState().setWidgetDensity('advanced');
  render(
    <EvidenceAvailabilityProvider>
      <MemoryUtilization catalog={catalog} defaultCollapsed={false} />
    </EvidenceAvailabilityProvider>,
  );

  const note = screen.getByText(/logStageExecutorMetrics/);
  expect(note).toBeInTheDocument();
  const row = note.closest('[data-flashed]') as HTMLElement;
  // The row's whole content IS the "evidence unavailable" note, so it carries
  // no evidence-link pill, bold label, or impact dot of its own: pointing one
  // at itself would be circular. The widget's evidence marker lives on the
  // header now, not on any individual row.
  expect(within(row).queryByRole('button', { name: /evidence:/i })).not.toBeInTheDocument();
  expect(row.querySelector('strong')).toBeNull();
  store.getState().setWidgetDensity('basic');
});

test('attaches executor-metrics evidence to ordinary memory findings (uniform disclosure contract)', async () => {
  store.getState().setWidgetDensity('advanced');
  render(
    <EvidenceAvailabilityProvider>
      <MemoryUtilization catalog={[{
        type: 'memoryUtilization', variant: 'memoryBand', stageId: null, executorId: '3',
        impactBand: 'warning', recommendation: 'Executor 3 needs more memory.',
      }]} defaultCollapsed={false} />
    </EvidenceAvailabilityProvider>,
  );

  // Evidence control is visible immediately; its accessible name always
  // carries the "Evidence:" prefix now, regardless of surrounding context.
  expect(screen.getByRole('button', { name: /^evidence: executor metrics$/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('a memoryUtilization row has no per-row toggle; its advice half is always visible, at both densities', () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null,
      impactBand: 'warning', metric: 'idleCoreRate', value: 75,
      recommendation: 'Over half of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.',
    },
  ];
  const advice = /reduce cluster size or enable dynamic allocation/;

  const { unmount } = render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);
  // Basic tier: the detail line (idle-core rate) and the advice half of the
  // recommendation are both visible, with no toggle needed to reveal either.
  expect(screen.getByText(/core-time idle/)).toBeInTheDocument();
  expect(screen.getByText(advice)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /recommendation for idle cores/i })).not.toBeInTheDocument();
  unmount();

  store.getState().setWidgetDensity('advanced');
  render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText(advice)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('renders the wasted MB-seconds raw-waste figure for a wasteModel finding', async () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
      impactBand: 'info', metric: 'wastedMBSeconds', value: 12345,
      recommendation: 'Allocated executor memory sat largely idle over the run.',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 12345, unit: 'mbSeconds' } },
    },
  ];
  render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);
  // formatRawWaste pins locale to en-US so the figure doesn't drift with the host locale.
  expect(screen.getByText(`${(12345).toLocaleString('en-US')} MB-s`)).toBeInTheDocument();
});

test('stays domain-agnostic: no company/industry copy leaks', () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null,
      impactBand: 'warning', recommendation: 'Over half of allocated core-time ran no task.',
    },
  ];
  render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.queryByText(/scanntech/i)).not.toBeInTheDocument();
});

test('the header status badge (confidence + evidence) is Advanced-only', () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
      impactBand: 'info', metric: 'wastedMBSeconds', value: 12345,
      confidence: 'low',
      validationRequired: 'Memory-waste estimate uses allocated-vs-used memory-time and a 1.5x buffer: confirm against the Spark UI before acting.',
      recommendation: 'Allocated executor memory sat largely idle over the run: review spark.executor.memory and executor count.',
    },
  ];

  store.getState().setWidgetDensity('basic');
  render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /evidence:/i })).not.toBeInTheDocument();
  cleanup();

  store.getState().setWidgetDensity('advanced');
  render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('button', { name: /evidence:/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('confidence and evidence markers stay out of the summary view until the card is expanded', async () => {
  const user = userEvent.setup();
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
      impactBand: 'info', metric: 'wastedMBSeconds', value: 12345,
      confidence: 'low',
      validationRequired: 'Memory-waste estimate uses allocated-vs-used memory-time and a 1.5x buffer: confirm against the Spark UI before acting.',
      recommendation: 'Allocated executor memory sat largely idle over the run: review spark.executor.memory and executor count.',
    },
  ];

  store.getState().setWidgetDensity('advanced');
  render(<MemoryUtilization catalog={catalog} />);
  expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /evidence:/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Memory Utilization' }));
  expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /evidence:/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('card defaults collapsed with worst-row summary when there are findings', () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null,
      impactBand: 'warning', metric: 'idleCoreRate', value: 75,
      recommendation: 'Over half of allocated core-time ran no task.',
    },
    {
      type: 'memoryUtilization', variant: 'memoryBand', stageId: null, executorId: '3',
      impactBand: 'info', metric: 'heapUsedRatio', value: 98,
      recommendation: 'Executor 3 needs more memory.',
    },
  ];

  render(<MemoryUtilization catalog={catalog} />);
  // Should show the summary with worst-row label and count
  expect(screen.getByText(/2 items flagged/)).toBeInTheDocument();
});

test('states a run-sized waste-model figure in GB-hours, matching the savings figure', () => {
  const catalog: Finding[] = [
    {
      type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
      impactBand: 'info', metric: 'wastedMBSeconds', value: 10_956_685.3,
      recommendation: 'Allocated executor memory sat largely idle over the run.',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 10_956_685.3, unit: 'mbSeconds' } },
    },
  ];
  render(<MemoryUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText(/~3\.0 GB-h wasted/)).toBeInTheDocument();
  expect(screen.queryByText(/MB-seconds/)).not.toBeInTheDocument();
});
