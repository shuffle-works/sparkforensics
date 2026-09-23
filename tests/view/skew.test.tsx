// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openStage = vi.fn();
vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage, close: vi.fn() }),
}));

import { Skew } from '@/view/widgets/Skew';
import { store } from '@/store/store';
import { expectImpactThenStageOrderByAccessibleName } from './_shared/sort-order-toggle';
import type { AppModel, Finding, TaskData } from '@sparkforensics/core/types.ts';

function makeStage(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `sql-scan-${id}`,
    taskDurationP50: 100,
    taskDurationP95: 500,
    taskDurationMax: 900,
    ...overrides,
  };
}

function makeAppModel(stageIds: number[]): AppModel {
  const stages = new Map<number, unknown>(stageIds.map((id) => [id, makeStage(id)]));
  return {
    app: null,
    stages: stages as unknown as AppModel['stages'],
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
  };
}

function skewFinding(stageId: number, value: number, impactBand: Finding['impactBand'] = 'critical'): Finding {
  return { type: 'skew', stageId, impactBand, metric: 'P95/median', value, recommendation: 'r' };
}

function slowHostFinding(
  stageId: number,
  host: string,
  ratio: number,
  hostTaskShare: number,
  impactBand: Finding['impactBand'] = 'warning',
): Finding {
  return {
    type: 'slowHost',
    stageId,
    impactBand,
    metric: 'hostMeanRatio',
    value: ratio,
    host,
    hostTaskShare,
    recommendation: 'r',
  };
}

function stragglerFinding(
  stageId: number,
  value: number,
  speculativeTasks = 0,
  impactBand: Finding['impactBand'] = 'warning',
): Finding {
  return {
    type: 'straggler',
    stageId,
    impactBand,
    metric: speculativeTasks > 0 ? 'speculativeTasks' : 'stragglerShare',
    value,
    speculativeTasks,
    recommendation: 'r',
  };
}

const FIELD_NAMES = ['duration', 'gcTime'];
const TASK_DATA: TaskData = {
  metrics: [100, 0, 200, 0, 300, 0, 400, 0, 500, 0, 600, 0],
  fieldNames: FIELD_NAMES,
};

describe('Skew', () => {
  it('renders the WidgetCard heading and a row for every flagged stage, not just the worst', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1, 2]);
    const catalog = [skewFinding(1, 8), skewFinding(2, 4, 'warning')];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    expect(screen.getByRole('heading', { name: 'Task Skew' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
  });

  it('shows the SKEW tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
    const appModel = makeAppModel([1, 2]);
    const catalog = [skewFinding(1, 8), skewFinding(2, 4, 'warning')];
    const getTaskData = vi.fn(async () => TASK_DATA);

    const { container } = render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    expect(screen.getByText('SKEW')).toBeInTheDocument();
    // One dot inside the header TagBadge itself, plus one per flagged stage row.
    expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
  });

  it('expanding a row lazily awaits getTaskData and then shows the duration histogram', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1, 2]);
    const catalog = [skewFinding(1, 8), skewFinding(2, 4, 'warning')];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));

    expect(getTaskData).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /show task detail for stage 1/i }));

    expect(getTaskData).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Task duration')).toBeInTheDocument();
    expect(getTaskData).not.toHaveBeenCalledWith(2);
  });

  it('does not fetch task data again once already expanded for a stage', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1]);
    const catalog = [skewFinding(1, 8)];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));

    const toggle = screen.getByRole('button', { name: /task detail for stage 1/i });
    await user.click(toggle);
    await screen.findByText('Task duration');
    await user.click(toggle); // collapse
    await user.click(toggle); // re-expand

    expect(getTaskData).toHaveBeenCalledTimes(1);
  });

  it('shows a speculative-task count in the straggler callout when speculation was used', () => {
    const appModel = makeAppModel([1]);
    const catalog = [skewFinding(1, 8), stragglerFinding(1, 20, 6)];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    expect(screen.getByText(/6 speculative tasks/)).toBeInTheDocument();
  });

  it('renders a PlanExplorer for an expanded row\'s stage when the stage has a linked plan', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    const planTree = { name: 'Scan parquet', detail: 'FileScan parquet', metrics: [], children: [] };
    const appModel: AppModel = {
      ...makeAppModel([1]),
      stages: new Map([[1, makeStage(1, { sqlExecutionId: 1 })]]) as unknown as AppModel['stages'],
      sql: new Map([[1, { executionId: 1, planTree }]]) as unknown as AppModel['sql'],
    };
    const catalog = [skewFinding(1, 8)];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));
    await user.click(screen.getByRole('button', { name: /show task detail for stage 1/i }));

    expect(await screen.findByText('Task duration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan context' })).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('hides the Plan context trigger at Basic density, even when the stage has a linked plan', async () => {
    const user = userEvent.setup();
    const planTree = { name: 'Scan parquet', detail: 'FileScan parquet', metrics: [], children: [] };
    const appModel: AppModel = {
      ...makeAppModel([1]),
      stages: new Map([[1, makeStage(1, { sqlExecutionId: 1 })]]) as unknown as AppModel['stages'],
      sql: new Map([[1, { executionId: 1, planTree }]]) as unknown as AppModel['sql'],
    };
    const catalog = [skewFinding(1, 8)];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));
    await user.click(screen.getByRole('button', { name: /show task detail for stage 1/i }));

    expect(await screen.findByText('Task duration')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plan context' })).not.toBeInTheDocument();
  });

  it('renders nothing when the catalog has no skew findings', () => {
    const appModel = makeAppModel([1]);
    const catalog: Finding[] = [{ type: 'shuffle', stageId: 1, impactBand: 'warning', metric: 'bytes', value: 1 }];
    const getTaskData = vi.fn(async () => TASK_DATA);

    const { container } = render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('scopes a stage row correctly: row 1 shows its own metric value, not stage 2\'s', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1, 2]);
    const catalog = [skewFinding(1, 8), skewFinding(2, 4, 'warning')];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));

    const row1 = screen.getByRole('button', { name: /open details for stage 1/i }).closest('div')!.parentElement!;
    expect(within(row1).getByText(/8×/)).toBeInTheDocument();
  });

  it('shows an error message instead of hanging on "Loading" when getTaskData rejects', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1]);
    const catalog = [skewFinding(1, 8)];
    const getTaskData = vi.fn(async () => {
      throw new Error('task data fetch failed');
    });

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));
    await user.click(screen.getByRole('button', { name: /show task detail for stage 1/i }));

    expect(await screen.findByText(/task data unavailable/i)).toBeInTheDocument();
  });

  it('shows an honest export-mode message instead of fetching task data', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1]);
    const catalog = [skewFinding(1, 8)];
    const getTaskData = vi.fn(async () => TASK_DATA);
    store.setState({ exportMode: true });

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));
    await user.click(screen.getByRole('button', { name: /show task detail for stage 1/i }));

    expect(await screen.findByText(/isn.t included in exported reports/i)).toBeInTheDocument();
    expect(getTaskData).not.toHaveBeenCalled();
    store.setState({ exportMode: false });
  });

  it('shows a slow-host callout on a skewed stage\'s row with the host, ratio, and task share', () => {
    const appModel = makeAppModel([1]);
    const catalog = [skewFinding(1, 8), slowHostFinding(1, 'worker-3', 3.5, 0.4)];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    expect(screen.getByText('Slow host:')).toBeInTheDocument();
    expect(screen.getByText(/worker-3 \(3\.5× median, 40% of tasks\)/)).toBeInTheDocument();
  });

  it('shows a straggler-share callout on a skewed stage\'s row', () => {
    const appModel = makeAppModel([1]);
    const catalog = [skewFinding(1, 8), stragglerFinding(1, 15)];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    expect(screen.getByText('Stragglers:')).toBeInTheDocument();
    expect(screen.getByText(/15% of tasks > 4× P50/)).toBeInTheDocument();
  });

  it('renders the impact estimate for a flagged skew finding', () => {
    const appModel = makeAppModel([1]);
    const finding: Finding = {
      ...skewFinding(1, 8),
      impactEstimate: { basis: 'serial', wallClock: { low: 800, high: 800 }, estimateMethod: 'measured', rawWaste: { value: 800, unit: 'ms' } },
    };
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={[finding]} getTaskData={getTaskData} />);

    expect(screen.getByText('800ms')).toBeInTheDocument();
  });

  it('defaults to impact order (highest potential savings first), and a toggle flips it back to stage order at advanced density', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    const appModel = makeAppModel([1, 2]);
    const catalog = [
      { ...skewFinding(1, 8), impactEstimate: { basis: 'serial' as const, wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' as const } },
      { ...skewFinding(2, 4, 'warning'), impactEstimate: { basis: 'serial' as const, wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' as const } },
    ];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));

    const rows = () => screen.getAllByRole('button', { name: /open details for stage \d/i });
    await expectImpactThenStageOrderByAccessibleName(user, rows, /stage 1/i, /stage 2/i);
    store.getState().setWidgetDensity('basic');
  });

  it('hides the sort toggle at basic density', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1, 2]);
    const catalog = [
      { ...skewFinding(1, 8), impactEstimate: { basis: 'serial' as const, wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' as const } },
      { ...skewFinding(2, 4, 'warning'), impactEstimate: { basis: 'serial' as const, wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' as const } },
    ];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));

    expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
  });

  it('does not give a stage its own row when it is only flagged by slowHost/straggler, not skew', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1, 2]);
    const catalog = [skewFinding(1, 8), slowHostFinding(2, 'worker-9', 5, 0.6)];
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));

    expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open details for stage 2/i })).not.toBeInTheDocument();
  });

  it('paginates the stage list 6-at-a-time with Previous/Next controls', async () => {
    const user = userEvent.setup();
    const stageIds = [1, 2, 3, 4, 5, 6, 7];
    const appModel = makeAppModel(stageIds);
    const catalog = stageIds.map((id) => skewFinding(id, 8));
    const getTaskData = vi.fn(async () => TASK_DATA);

    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);
    await user.click(screen.getByRole('button', { name: /^task skew$/i }));

    expect(screen.getAllByRole('button', { name: /open details for stage \d/i })).toHaveLength(6);
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getAllByRole('button', { name: /open details for stage \d/i })).toHaveLength(1);
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('shows a confidence caveat when the skew finding carries one', () => {
    const appModel = makeAppModel([1]);
    const catalog: Finding[] = [{
      ...skewFinding(1, 8),
      confidence: 'low',
      validationRequired: 'This finding is gated by a 0.5% runtime-floor threshold, our own noise floor for this metric.',
    }];
    const getTaskData = vi.fn(async () => TASK_DATA);

    store.getState().setWidgetDensity('advanced');
    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    const caveat = screen.getByText(/low confidence/i);
    expect(caveat).toBeInTheDocument();
    expect(caveat).toHaveAttribute('title', catalog[0].validationRequired);
    store.getState().setWidgetDensity('basic');
  });

  it('surfaces the skew/straggler overlap note through the same confidence caveat when both fire on the same stage', () => {
    const appModel = makeAppModel([1]);
    const catalog: Finding[] = [{
      ...skewFinding(1, 8),
      confidence: 'low',
      validationRequired: "This overlaps with the straggler finding on this stage: both are driven by the same dominant outlier task, so don't add their recoverable-time figures together.",
    }];
    const getTaskData = vi.fn(async () => TASK_DATA);

    store.getState().setWidgetDensity('advanced');
    render(<Skew appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    expect(screen.getByText(/low confidence/i).getAttribute('title')).toMatch(/overlaps with the straggler finding/);
    store.getState().setWidgetDensity('basic');
  });
});
