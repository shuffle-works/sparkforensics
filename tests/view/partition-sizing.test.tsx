// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { PartitionSizing } from '@/view/widgets/PartitionSizing';
import { emptyAppModel, store } from '@/store/store';
import { expectImpactThenStageOrderByArray } from './_shared/sort-order-toggle';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

function buildAppModel(stages: Record<number, Record<string, unknown>>): AppModel {
  const map = new Map<number, unknown>(
    Object.entries(stages).map(([id, fields]) => [Number(id), { id: Number(id), ...fields }]),
  );
  return { ...emptyAppModel(), stages: map as unknown as AppModel['stages'] };
}

test('renders the WidgetCard heading', () => {
  const appModel = buildAppModel({ 3: { taskCount: 4 } });
  const catalog: Finding[] = [{
    type: 'partitionSizing', stageId: 3, impactBand: 'critical',
    recommendation: 'Repartition to break it up before this stage.',
  }];
  render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Partition Sizing' })).toBeInTheDocument();
});

test('flags every affected stage, not just the worst', () => {
  const appModel = buildAppModel({ 1: { taskCount: 4 }, 2: { taskCount: 3 } });
  const catalog: Finding[] = [
    { type: 'partitionSizing', stageId: 1, impactBand: 'info', rule: 'lowShuffleParallelism', value: 4, recommendation: 'r1' },
    { type: 'partitionSizing', stageId: 2, impactBand: 'critical', rule: 'lowShuffleParallelism', value: 3, recommendation: 'r2' },
  ];
  render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
});

test('shows the PART tag and each rule\'s label/recommendation', () => {
  const appModel = buildAppModel({ 3: { taskCount: 4 } });
  const catalog: Finding[] = [{
    type: 'partitionSizing', stageId: 3, impactBand: 'critical', rule: 'lowShuffleParallelism', value: 4,
    recommendation: 'A single shuffle partition exceeds 5 GB. Repartition to break it up before this stage.',
  }];
  render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('PART')).toBeInTheDocument();
  expect(screen.getByText(/4 tasks carrying the shuffle/)).toBeInTheDocument();
  expect(screen.getByText(/repartition to break it up/i)).toBeInTheDocument();
});

test('renders no domain/company strings and no bytes-formatting bug for a task-count value', () => {
  const appModel = buildAppModel({ 3: { taskCount: 4 } });
  const catalog: Finding[] = [{
    type: 'partitionSizing', stageId: 3, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 4,
    recommendation: 'raise spark.sql.shuffle.partitions so each partition is smaller.',
  }];
  const { container } = render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
  // formatBytes(4) would render '4 B', the historical bug this guards against.
  expect(screen.queryByText('4 B')).not.toBeInTheDocument();
});

test('renders a muted empty-state card when the catalog has no partitionSizing findings', () => {
  const appModel = buildAppModel({ 1: { taskCount: 10 } });
  render(<PartitionSizing appModel={appModel} catalog={[]} />);
  expect(screen.getByText(/no partition-sizing issues detected/i)).toBeInTheDocument();
});

test('embeds PlanExplorer output for a stage with a linked SQL plan tree, at Advanced tier only', async () => {
  const user = userEvent.setup();
  const { store } = await import('@/store/store');
  store.getState().setWidgetDensity('advanced');
  const planTree = {
    name: 'Scan parquet',
    detail: 'FileScan parquet [id#1] Batched: true, Format: Parquet, Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events]',
    metrics: [], children: [],
  };
  const appModel = buildAppModel({ 1: { taskCount: 4, sqlExecutionId: 1 } });
  appModel.sql.set(1, { executionId: 1, planTree } as never);
  const catalog: Finding[] = [{ type: 'partitionSizing', stageId: 1, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 4, recommendation: 'r' }];

  render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);
  await user.click(screen.getByRole('button', { name: 'Plan context' }));
  await user.click(screen.getByRole('tab', { name: 'Summary' }));
  expect(screen.getByText(/events/)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('defaults to impact order (highest potential savings first), and a toggle flips it back to stage order at advanced density', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const appModel = buildAppModel({ 1: { taskCount: 4 }, 2: { taskCount: 3 } });
  const catalog: Finding[] = [
    {
      type: 'partitionSizing', stageId: 1, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 4, recommendation: 'r1',
      impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' },
    },
    {
      type: 'partitionSizing', stageId: 2, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 3, recommendation: 'r2',
      impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' },
    },
  ];
  render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);

  const names = () => screen.getAllByRole('button', { name: /open details for stage \d/i }).map((b) => b.getAttribute('aria-label'));
  await expectImpactThenStageOrderByArray(user, names, 'Open details for Stage 1', 'Open details for Stage 2');
  store.getState().setWidgetDensity('basic');
});

test('card defaults to collapsed with lead summary on the empty-state branch', () => {
  const appModel = buildAppModel({ 1: { taskCount: 10 }, 2: { taskCount: 20 } });
  render(<PartitionSizing appModel={appModel} catalog={[]} />);

  // Lead summary renders even while the card is collapsed by default.
  expect(screen.getByText('No issues')).toBeInTheDocument();
  expect(screen.getByText(/partition sizing checked across 2 stages/i)).toBeInTheDocument();
});

test('card defaults to collapsed with lead summary on the populated branch', () => {
  const appModel = buildAppModel({ 3: { taskCount: 4 } });
  const catalog: Finding[] = [{
    type: 'partitionSizing', stageId: 3, impactBand: 'critical', rule: 'lowShuffleParallelism', value: 4,
    recommendation: 'Repartition to break it up before this stage.',
  }];
  render(<PartitionSizing appModel={appModel} catalog={catalog} />);

  // Lead summary shows the worst stage id and stays visible while collapsed.
  const results = screen.queryAllByText(/Stage 3/);
  expect(results.length).toBeGreaterThan(0);
});

test('sort toggle only renders when card is open, at advanced density', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const appModel = buildAppModel({ 1: { taskCount: 4 }, 2: { taskCount: 3 } });
  const catalog: Finding[] = [
    {
      type: 'partitionSizing', stageId: 1, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 4, recommendation: 'r1',
      impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' },
    },
    {
      type: 'partitionSizing', stageId: 2, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 3, recommendation: 'r2',
      impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' },
    },
  ];
  render(<PartitionSizing appModel={appModel} catalog={catalog} />);

  // Sort toggle should not be visible when the card is collapsed.
  expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument();

  const cardButton = screen.getByRole('button', { name: 'Partition Sizing' });
  await user.click(cardButton);

  expect(screen.getByRole('button', { name: 'Stage' })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('sort toggle stays hidden at basic density even when the card is open', () => {
  const appModel = buildAppModel({ 1: { taskCount: 4 }, 2: { taskCount: 3 } });
  const catalog: Finding[] = [
    {
      type: 'partitionSizing', stageId: 1, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 4, recommendation: 'r1',
      impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' },
    },
    {
      type: 'partitionSizing', stageId: 2, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 3, recommendation: 'r2',
      impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' },
    },
  ];
  render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);

  expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
});

test('does not render pagination controls when everything fits on one page', () => {
  const appModel = buildAppModel({ 3: { taskCount: 4 } });
  const catalog: Finding[] = [{
    type: 'partitionSizing', stageId: 3, impactBand: 'critical', rule: 'lowShuffleParallelism', value: 4,
    recommendation: 'r',
  }];
  render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);

  expect(screen.queryByRole('button', { name: /^previous$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: /jump to stage/i })).not.toBeInTheDocument();
});

test('paginates stages 6-at-a-time with a jump-to-stage dropdown', async () => {
  const user = userEvent.setup();
  const stages: Record<number, Record<string, unknown>> = {};
  const catalog: Finding[] = [];
  for (let i = 1; i <= 8; i++) {
    stages[i] = { taskCount: 9 - i, name: `stage-name-${i}` };
    catalog.push({ type: 'partitionSizing', stageId: i, impactBand: 'warning', rule: 'lowShuffleParallelism', value: 9 - i, recommendation: `r${i}` });
  }
  const appModel = buildAppModel(stages);
  render(<PartitionSizing appModel={appModel} catalog={catalog} defaultCollapsed={false} />);

  for (let i = 1; i <= 6; i++) expect(screen.getByText(`stage-name-${i}`)).toBeInTheDocument();
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

  await user.click(screen.getByRole('combobox', { name: /jump to stage/i }));
  await user.click(await screen.findByRole('option', { name: /stage 8/i }));
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  expect(screen.getByText('stage-name-8')).toBeInTheDocument();
});
