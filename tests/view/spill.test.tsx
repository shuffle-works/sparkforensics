// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openStage = vi.fn();
vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage, close: vi.fn() }),
}));

import { Spill } from '@/view/widgets/Spill';
import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { expectImpactThenStageOrderByAccessibleName } from './_shared/sort-order-toggle';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

function buildAppModel(stageOverrides: Record<number, Record<string, unknown>> = {}): AppModel {
  const stages = new Map<number, unknown>([
    [1, { id: 1, memoryBytesSpilled: 600 * 1024 * 1024, diskBytesSpilled: 100 * 1024 * 1024, spillClassification: 'volume', shuffleReadBytes: 1024 * 1024 * 1024, taskCount: 4, sqlExecutionId: null }],
    [2, { id: 2, memoryBytesSpilled: 300 * 1024 * 1024, diskBytesSpilled: 0, spillClassification: 'skew', sqlExecutionId: null }],
  ]);
  for (const [id, overrides] of Object.entries(stageOverrides)) {
    stages.set(Number(id), { ...(stages.get(Number(id)) as object), ...overrides });
  }
  return { ...emptyAppModel(), stages: stages as unknown as AppModel['stages'] };
}

function makeCatalog(): Finding[] {
  return [
    { type: 'spill', stageId: 1, impactBand: 'critical', value: 600 * 1024 * 1024, recommendation: 'Raise spark.sql.shuffle.partitions or increase executor memory.', confidence: 'low' },
    { type: 'spill', stageId: 2, impactBand: 'warning', value: 300 * 1024 * 1024, recommendation: 'Spill is skew-driven: fix task skew first; adding memory will not help.', confidence: 'low' },
  ];
}

test('renders the Spill heading', () => {
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.getByRole('heading', { name: /spill/i })).toBeInTheDocument();
});

test('shows the SPILL tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
  const { container } = render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} defaultCollapsed={false} />
    </DocsProvider>,
  );
  expect(screen.getByText('SPILL')).toBeInTheDocument();
  // One dot inside the header TagBadge itself, plus one per flagged stage row.
  // MemoryPressure's own critical/warning/info legend (inside its tabpanel)
  // renders three more `ImpactDot`s that aren't part of this contract, so
  // exclude those.
  const allDots = container.querySelectorAll('.size-2.rounded-full');
  const legendDots = container.querySelectorAll('[role="tabpanel"] .size-2.rounded-full');
  expect(allDots.length - legendDots.length).toBe(3);
});

test('per-row confidence marker is Advanced-only', () => {
  const catalog: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'critical', value: 600 * 1024 * 1024, recommendation: 'Raise spark.sql.shuffle.partitions or increase executor memory.', confidence: 'low' },
  ];

  store.getState().setWidgetDensity('basic');
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={catalog} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();

  cleanup();

  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={catalog} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.getByText(/confidence/i)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('flags every affected stage, not just the worst', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  // One row per flagged stage, each with its own StagePill.
  await user.click(screen.getByRole('button', { name: /^spill$/i }));
  expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
});

test('flags every affected stage with its confidence caveat, at advanced density', async () => {
  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  // Both stages carry a "low" confidence finding: RowStatusCluster is
  // Advanced-only, so both show up in Advanced tier with no per-row click.
  expect(screen.getAllByText(/low confidence/i)).toHaveLength(2);
  store.getState().setWidgetDensity('basic');
});

test('hides the confidence caveat at basic density', async () => {
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();
});

test('spill classification is visible for every stage without any interaction', () => {
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.getByText('vol')).toBeInTheDocument();
  expect(screen.getByText('skew')).toBeInTheDocument();
});

test('shows the partition-count hint only for volume-classified spill', async () => {
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.getByText(/spark\.sql\.shuffle\.partitions = 8/)).toBeInTheDocument();
});

test('does not show the partition hint for skew-classified spill', async () => {
  const catalog: Finding[] = [
    { type: 'spill', stageId: 2, impactBand: 'warning', value: 300 * 1024 * 1024, recommendation: 'Spill is skew-driven: fix task skew first; adding memory will not help.' },
  ];
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={catalog} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.queryByText(/spark\.sql\.shuffle\.partitions =/)).not.toBeInTheDocument();
});

test('surfaces a low-confidence caveat when the finding carries one', async () => {
  // `Finding.validationRequired` is typed `boolean` but every real emitter
  // assigns a string message and every renderer reads it as one; cast at the
  // literal to match runtime shape.
  const catalog: Finding[] = [
    {
      type: 'spill', stageId: 2, impactBand: 'warning', value: 300 * 1024 * 1024,
      confidence: 'low', validationRequired: 'Spill cause could not be classified: inspect per-task spill metrics in the Spark UI before acting.',
    },
  ];
  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel({ 2: { spillClassification: 'unclassified' } })} catalog={catalog} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  // Visible text is just "low confidence": `validationRequired` itself stays
  // hidden behind the `title` tooltip (+ sr-only span for screen readers).
  // RowStatusCluster is Advanced-only.
  const caveat = screen.getByText(/low confidence/i);
  expect(caveat).toBeInTheDocument();
  expect(caveat).toHaveAttribute(
    'title',
    'Spill cause could not be classified: inspect per-task spill metrics in the Spark UI before acting.',
  );
  expect(screen.queryByText(/inspect per-task spill metrics/, { selector: ':not(.sr-only)' })).not.toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('renders the impact estimate under a flagged spill finding', () => {
  const catalog: Finding[] = [
    {
      type: 'spill', stageId: 1, impactBand: 'critical', value: 600 * 1024 * 1024,
      recommendation: 'Raise spark.sql.shuffle.partitions or increase executor memory.',
      impactEstimate: { basis: 'serial', wallClock: { low: 800, high: 800 }, estimateMethod: 'measured', rawWaste: { value: 800, unit: 'ms' } },
    },
  ];
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={catalog} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.getByText('800ms')).toBeInTheDocument();
});

test('defaults to impact order (highest potential savings first), and a toggle flips it back to stage order at advanced density', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const catalog: Finding[] = [
    {
      type: 'spill', stageId: 1, impactBand: 'critical', value: 600 * 1024 * 1024,
      recommendation: 'r', impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' },
      confidence: 'low',
    },
    {
      type: 'spill', stageId: 2, impactBand: 'warning', value: 300 * 1024 * 1024,
      recommendation: 'r', impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' },
      confidence: 'low',
    },
  ];
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={catalog} getTaskData={vi.fn()} defaultCollapsed={false} />
    </DocsProvider>,
  );
  // Stage 1 is the worse impact band (critical vs warning) but stage 2 has the
  // higher potential savings: impact order puts stage 2 first by default.
  const pills = () => screen.getAllByRole('button', { name: /open details for stage \d/i });
  await expectImpactThenStageOrderByAccessibleName(user, pills, /stage 1/i, /stage 2/i);
  store.getState().setWidgetDensity('basic');
});

test('hides the sort toggle when no finding carries a wall-clock estimate, even at advanced density', () => {
  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('hides the sort toggle at basic density even with a wall-clock estimate', () => {
  const catalog: Finding[] = [
    {
      type: 'spill', stageId: 1, impactBand: 'critical', value: 600 * 1024 * 1024,
      recommendation: 'r', impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' },
      confidence: 'low',
    },
    {
      type: 'spill', stageId: 2, impactBand: 'warning', value: 300 * 1024 * 1024,
      recommendation: 'r', impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' },
      confidence: 'low',
    },
  ];
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={catalog} getTaskData={vi.fn()} defaultCollapsed={false} />
    </DocsProvider>,
  );
  expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
});

test('renders a muted clean-state message with the max observed spill when there is no spill finding', () => {
  const appModel = buildAppModel({ 1: { memoryBytesSpilled: 0 }, 2: { memoryBytesSpilled: 0 } });
  render(<Spill appModel={appModel} catalog={[]} getTaskData={vi.fn()} />);
  expect(screen.getByText(/no issue detected/i)).toBeInTheDocument();
});

test('renders MemoryPressure with its real chart content, not just a stub', async () => {
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} defaultCollapsed={false} />
    </DocsProvider>,
  );
  expect(screen.getByRole('img', { name: /memory pressure/i })).toBeInTheDocument();
});

test('shows the memory-pressure chart before the stage list', async () => {
  const { container } = render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  const chartIndex = container.textContent!.indexOf('Spill and GC pressure');
  const rowIndex = container.textContent!.indexOf('Memory spilled:');
  expect(chartIndex).toBeGreaterThan(-1);
  expect(rowIndex).toBeGreaterThan(-1);
  expect(chartIndex).toBeLessThan(rowIndex);
});

test('renders no domain-specific copy', () => {
  const { container } = render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
});

test('a stage row shows its recommendation immediately, no expansion needed', async () => {
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );

  expect(screen.queryAllByText(/memory spilled:/i).length).toBeGreaterThan(0);
  expect(screen.getByText(/raise spark\.sql\.shuffle\.partitions or increase executor memory/i)).toBeInTheDocument();
});

test('paginates the stage list 6-at-a-time with Previous/Next controls', async () => {
  const user = userEvent.setup();
  const stages = new Map<number, unknown>();
  const catalog: Finding[] = [];
  for (let i = 1; i <= 7; i++) {
    stages.set(i, { id: i, memoryBytesSpilled: i * 1024 * 1024, diskBytesSpilled: 0, spillClassification: 'skew' });
    catalog.push({ type: 'spill', stageId: i, impactBand: 'warning', value: i * 1024 * 1024, confidence: 'low' });
  }
  const appModel = { ...buildAppModel(), stages: stages as unknown as AppModel['stages'] };

  render(
    <DocsProvider>
      <Spill appModel={appModel} catalog={catalog} getTaskData={vi.fn()} defaultCollapsed={false} />
    </DocsProvider>,
  );

  expect(screen.getAllByRole('button', { name: /open details for stage \d/i })).toHaveLength(6);
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getAllByRole('button', { name: /open details for stage \d/i })).toHaveLength(1);
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
});

test('renders no status cluster at all when a row has no confidence, even at advanced density', async () => {
  const catalog: Finding[] = [
    { type: 'spill', stageId: 2, impactBand: 'warning', value: 300 * 1024 * 1024, recommendation: 'Spill is skew-driven: fix task skew first; adding memory will not help.' },
  ];
  store.getState().setWidgetDensity('advanced');
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={catalog} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('shows a single Plan context toggle (collapsed by default) exposing PlanExplorer, only at advanced density for a stage with a linked plan', async () => {
  const user = userEvent.setup();
  const planTree = { name: 'Scan parquet', detail: 'FileScan parquet', metrics: [], children: [] };
  const appModel: AppModel = {
    ...buildAppModel(),
    stages: new Map([
      [1, { id: 1, memoryBytesSpilled: 600 * 1024 * 1024, diskBytesSpilled: 0, spillClassification: 'volume', sqlExecutionId: 1 }],
    ]) as unknown as AppModel['stages'],
    sql: new Map([[1, { executionId: 1, planTree }]]) as unknown as AppModel['sql'],
  };
  const catalog: Finding[] = [
    { type: 'spill', stageId: 1, impactBand: 'critical', value: 600 * 1024 * 1024, confidence: 'low' },
  ];

  // Basic density: no Plan context toggle at all.
  const { rerender } = render(
    <DocsProvider>
      <Spill appModel={appModel} catalog={catalog} getTaskData={vi.fn()} defaultCollapsed={false} />
    </DocsProvider>,
  );
  expect(screen.queryByText(/plan context/i)).not.toBeInTheDocument();

  store.getState().setWidgetDensity('advanced');
  rerender(
    <DocsProvider>
      <Spill appModel={appModel} catalog={catalog} getTaskData={vi.fn()} defaultCollapsed={false} />
    </DocsProvider>,
  );

  // Only PlanExplorer's own "Plan context" disclosure renders (collapsed by
  // default), no separate row-level toggle wrapping it.
  const toggles = screen.getAllByRole('button', { name: 'Plan context' });
  expect(toggles).toHaveLength(1);
  expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');

  await user.click(toggles[0]);
  expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
  store.getState().setWidgetDensity('basic');
});

test('card defaults collapsed and shows the peak-spill summary in the collapsed state', () => {
  render(
    <DocsProvider>
      <Spill appModel={buildAppModel()} catalog={makeCatalog()} getTaskData={vi.fn()} />
    </DocsProvider>,
  );
  const cardButton = screen.getByRole('button', { name: 'Spill' });
  expect(cardButton).toHaveAttribute('aria-expanded', 'false');
  // Summary shows `sorted[0]`'s peak value (stage 1, critical) plus stage count.
  const summaryContext = screen.getByText('peak · 2 stages');
  expect(summaryContext).toBeVisible();
  // The row content (keepMounted) stays in the DOM but hidden while collapsed.
  for (const row of screen.getAllByText(/memory spilled:/i)) {
    expect(row).not.toBeVisible();
  }
});
