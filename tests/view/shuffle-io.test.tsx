// tests/view/shuffle-io.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { ShuffleIO } from '@/view/widgets/ShuffleIO';
import { emptyAppModel, store } from '@/store/store';
import { expectImpactThenStageOrderByArray } from './_shared/sort-order-toggle';
import type { AppModel, Finding, PlanNode } from '@sparkforensics/core/types.ts';

function buildAppModel(stages: Record<number, Record<string, unknown>>): AppModel {
  const map = new Map<number, unknown>(
    Object.entries(stages).map(([id, fields]) => [Number(id), { id: Number(id), ...fields }]),
  );
  return { ...emptyAppModel(), stages: map as unknown as AppModel['stages'] };
}

test('renders the WidgetCard heading', () => {
  const appModel = buildAppModel({ 1: { shuffleReadBytes: 600 * 1024 * 1024, shuffleWriteBytes: 10 * 1024 * 1024 } });
  const catalog: Finding[] = [{ type: 'shuffle', stageId: 1, impactBand: 'warning', value: 600 * 1024 * 1024 }];
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  expect(screen.getByRole('heading', { name: 'Shuffle I/O' })).toBeInTheDocument();
});

test('flags every affected stage, not just the worst', () => {
  const appModel = buildAppModel({
    1: { shuffleReadBytes: 200 * 1024 * 1024, shuffleWriteBytes: 5 * 1024 * 1024 },
    2: { shuffleReadBytes: 900 * 1024 * 1024, shuffleWriteBytes: 20 * 1024 * 1024 },
  });
  const catalog: Finding[] = [
    { type: 'shuffle', stageId: 1, impactBand: 'info', value: 200 * 1024 * 1024 },
    { type: 'shuffle', stageId: 2, impactBand: 'critical', value: 900 * 1024 * 1024 },
  ];
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);

  expect(screen.getAllByRole('button', { name: /open details for stage 1/i }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole('button', { name: /open details for stage 2/i }).length).toBeGreaterThan(0);
});

test('shows the SHFL tag for a shuffle finding', () => {
  const appModel = buildAppModel({ 1: { shuffleReadBytes: 600 * 1024 * 1024, shuffleWriteBytes: 0 } });
  const catalog: Finding[] = [{ type: 'shuffle', stageId: 1, impactBand: 'warning', value: 600 * 1024 * 1024 }];
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  expect(screen.getByText('SHFL')).toBeInTheDocument();
});

test('renders the impact estimate under a flagged shuffle finding', () => {
  const appModel = buildAppModel({ 1: { shuffleReadBytes: 600 * 1024 * 1024, shuffleWriteBytes: 10 * 1024 * 1024 } });
  const catalog: Finding[] = [
    {
      type: 'shuffle', stageId: 1, impactBand: 'warning', value: 600 * 1024 * 1024,
      impactEstimate: { basis: 'serial', wallClock: { low: 800, high: 800 }, estimateMethod: 'measured', rawWaste: { value: 800, unit: 'ms' } },
    },
  ];
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  expect(screen.getByText('800ms')).toBeInTheDocument();
});

test('renders a muted no-issue message when the catalog has no shuffle findings', () => {
  const appModel = buildAppModel({ 1: { shuffleReadBytes: 10 * 1024 * 1024, shuffleWriteBytes: 5 * 1024 * 1024 } });
  render(<ShuffleIO appModel={appModel} catalog={[]} getTaskData={async () => null as never} />);
  expect(screen.getByText(/no shuffle read\/write issues detected/i)).toBeInTheDocument();
});

test('the clean state still surfaces the peak shuffle-read figure across all stages', () => {
  const appModel = buildAppModel({
    1: { shuffleReadBytes: 10 * 1e6, shuffleWriteBytes: 5 * 1024 * 1024 },
    2: { shuffleReadBytes: 600 * 1e6, shuffleWriteBytes: 0 },
  });
  render(<ShuffleIO appModel={appModel} catalog={[]} getTaskData={async () => null as never} />);
  expect(screen.getByText(/peak shuffle read/i)).toBeInTheDocument();
  expect(screen.getByText('600 MB')).toBeInTheDocument();
});

test('embeds PlanExplorer output for a stage with a linked SQL plan tree', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const planTree: PlanNode = {
    name: 'Scan parquet',
    detail: 'FileScan parquet [id#1] Batched: true, Format: Parquet, Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events], PushedFilters: [], ReadSchema: struct<id:int>',
    metrics: [], children: [],
  };
  const appModel = buildAppModel({ 1: { shuffleReadBytes: 600 * 1024 * 1024, shuffleWriteBytes: 10 * 1024 * 1024, sqlExecutionId: 1 } });
  appModel.sql.set(1, { id: 1, planTree });
  const catalog: Finding[] = [{ type: 'shuffle', stageId: 1, impactBand: 'warning', value: 600 * 1024 * 1024 }];

  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  await user.click(screen.getByRole('button', { name: 'Plan context' }));
  await user.click(screen.getByRole('tab', { name: 'Summary' }));
  expect(screen.getByText(/events/)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('the Plan context trigger only appears at Advanced tier', () => {
  store.getState().setWidgetDensity('basic');
  const planTree: PlanNode = {
    name: 'Scan parquet', detail: 'FileScan parquet [id#1]', metrics: [], children: [],
  };
  const appModel = buildAppModel({ 1: { shuffleReadBytes: 600 * 1024 * 1024, shuffleWriteBytes: 10 * 1024 * 1024, sqlExecutionId: 1 } });
  appModel.sql.set(1, { id: 1, planTree });
  const catalog: Finding[] = [{ type: 'shuffle', stageId: 1, impactBand: 'warning', value: 600 * 1024 * 1024 }];
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  expect(screen.queryByRole('button', { name: /plan context/i })).not.toBeInTheDocument();
});

test('renders no domain/company strings', () => {
  const appModel = buildAppModel({ 1: { shuffleReadBytes: 600 * 1024 * 1024, shuffleWriteBytes: 5 * 1024 * 1024 } });
  const catalog: Finding[] = [{ type: 'shuffle', stageId: 1, impactBand: 'warning', value: 600 * 1024 * 1024 }];
  const { container } = render(<ShuffleIO appModel={appModel} catalog={catalog} getTaskData={async () => null as never} />);
  expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
});

function buildPaginatedFixture() {
  const stages: Record<number, Record<string, unknown>> = {};
  const catalog: Finding[] = [];
  for (let i = 1; i <= 8; i++) {
    const value = (9 - i) * 100 * 1024 * 1024;
    stages[i] = { shuffleReadBytes: value, shuffleWriteBytes: 0, name: `stage-name-${i}` };
    catalog.push({ type: 'shuffle', stageId: i, impactBand: 'warning', value });
  }
  return { appModel: buildAppModel(stages), catalog };
}

test('paginates stage detail 6-at-a-time, hiding the rest until Next is clicked', async () => {
  const user = userEvent.setup();
  const { appModel, catalog } = buildPaginatedFixture();
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  for (let i = 1; i <= 6; i++) expect(screen.getByText(`stage-name-${i}`)).toBeInTheDocument();
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^next$/i }));
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  expect(screen.getByText('stage-name-7')).toBeInTheDocument();
  expect(screen.getByText('stage-name-8')).toBeInTheDocument();
});

test('defaults to impact order (highest potential savings first), and a toggle flips it back to stage order at advanced density', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const appModel = buildAppModel({
    1: { shuffleReadBytes: 900 * 1024 * 1024, shuffleWriteBytes: 0, name: 'stage-1' },
    2: { shuffleReadBytes: 100 * 1024 * 1024, shuffleWriteBytes: 0, name: 'stage-2' },
  });
  const catalog: Finding[] = [
    { type: 'shuffle', stageId: 1, impactBand: 'warning', value: 900 * 1024 * 1024, impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } },
    { type: 'shuffle', stageId: 2, impactBand: 'warning', value: 100 * 1024 * 1024, impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } },
  ];
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  const names = () => screen.getAllByText(/^stage-\d$/).map((el) => el.textContent);
  await expectImpactThenStageOrderByArray(user, names, 'stage-1', 'stage-2');
  store.getState().setWidgetDensity('basic');
});

test('sort toggle stays hidden at basic density regardless of card state', () => {
  const appModel = buildAppModel({
    1: { shuffleReadBytes: 900 * 1024 * 1024, shuffleWriteBytes: 0, name: 'stage-1' },
    2: { shuffleReadBytes: 100 * 1024 * 1024, shuffleWriteBytes: 0, name: 'stage-2' },
  });
  const catalog: Finding[] = [
    { type: 'shuffle', stageId: 1, impactBand: 'warning', value: 900 * 1024 * 1024, impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } },
    { type: 'shuffle', stageId: 2, impactBand: 'warning', value: 100 * 1024 * 1024, impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } },
  ];
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
});

test('"Jump to stage" dropdown jumps straight to the page containing the picked stage', async () => {
  const user = userEvent.setup();
  const { appModel, catalog } = buildPaginatedFixture();
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);
  await user.click(screen.getByRole('combobox', { name: /jump to stage/i }));
  await user.click(await screen.findByRole('option', { name: /stage 8/i }));
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  expect(screen.getByText('stage-name-8')).toBeInTheDocument();
});

test('card defaults to collapsed with lead summary on the empty-state branch', () => {
  const appModel = buildAppModel({
    1: { shuffleReadBytes: 10 * 1e6, shuffleWriteBytes: 5 * 1024 * 1024 },
    2: { shuffleReadBytes: 600 * 1e6, shuffleWriteBytes: 0 },
  });
  render(<ShuffleIO appModel={appModel} catalog={[]} getTaskData={async () => null as never} />);

  // Lead summary displays the peak shuffle-read value even while the card
  // is collapsed by default.
  expect(screen.getByText('600 MB')).toBeInTheDocument();
  expect(screen.getByText(/peak shuffle read/i)).toBeInTheDocument();
});

test('card defaults to collapsed with lead summary on the populated branch', () => {
  const appModel = buildAppModel({
    1: { shuffleReadBytes: 600 * 1e6, shuffleWriteBytes: 10 * 1e6 },
  });
  const catalog: Finding[] = [{ type: 'shuffle', stageId: 1, impactBand: 'warning', value: 600 * 1e6 }];
  render(<ShuffleIO appModel={appModel} catalog={catalog} getTaskData={async () => null as never} />);

  // Lead summary displays the peak value (visible even when the card is
  // closed). There may be multiple "600 MB" matches (summary + row detail),
  // so just check at least one exists.
  const results = screen.queryAllByText('600 MB');
  expect(results.length).toBeGreaterThan(0);
});

test('sort toggle only renders when card is open, at advanced density', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  const appModel = buildAppModel({
    1: { shuffleReadBytes: 900 * 1e6, shuffleWriteBytes: 0, name: 'stage-1' },
    2: { shuffleReadBytes: 100 * 1e6, shuffleWriteBytes: 0, name: 'stage-2' },
  });
  const catalog: Finding[] = [
    {
      type: 'shuffle', stageId: 1, impactBand: 'warning', value: 900 * 1e6,
      impactEstimate: { basis: 'serial', wallClock: { low: 1000, high: 1000 }, estimateMethod: 'measured' },
    },
    {
      type: 'shuffle', stageId: 2, impactBand: 'warning', value: 100 * 1e6,
      impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' },
    },
  ];
  render(<ShuffleIO appModel={appModel} catalog={catalog} getTaskData={async () => null as never} />);

  // Sort toggle should not be visible when the card is collapsed.
  expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument();

  const cardButton = screen.getByRole('button', { name: 'Shuffle I/O' });
  await user.click(cardButton);

  expect(screen.getByRole('button', { name: 'Stage' })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('does not render pagination controls when everything fits on one page', async () => {
  const appModel = buildAppModel({ 1: { shuffleReadBytes: 600 * 1024 * 1024, shuffleWriteBytes: 0 } });
  const catalog: Finding[] = [{ type: 'shuffle', stageId: 1, impactBand: 'warning', value: 600 * 1024 * 1024 }];
  render(<ShuffleIO appModel={appModel} catalog={catalog} defaultCollapsed={false} getTaskData={async () => null as never} />);

  expect(screen.queryByRole('button', { name: /^previous$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: /jump to stage/i })).not.toBeInTheDocument();
});

