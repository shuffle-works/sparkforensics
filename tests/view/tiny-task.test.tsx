// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { TinyTask } from '@/view/widgets/TinyTask';
import { store } from '@/store/store';
import type { AppModel, Finding, TaskData } from '@sparkforensics/core/types.ts';

function makeAppModel(stageIds: number[]): AppModel {
  const stages = new Map<number, unknown>(
    stageIds.map((id) => [id, { id, name: `sql-scan-${id}`, taskDurationP50: 40, taskDurationP95: 60, taskDurationMax: 90 }]),
  );
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

function tinyTaskFinding(stageId: number, value: number): Finding {
  return { type: 'tinyTask', stageId, impactBand: 'info', metric: 'taskDurationP50', value, recommendation: 'r' };
}

function stragglerFinding(stageId: number, value: number): Finding {
  return { type: 'straggler', stageId, impactBand: 'warning', metric: 'stragglerShare', value, recommendation: 'r' };
}

const TASK_DATA: TaskData = { metrics: [40, 0, 60, 0, 80, 0, 100, 0, 120, 0, 140, 0], fieldNames: ['duration', 'gcTime'] };

describe('TinyTask', () => {
  it('renders the WidgetCard heading and its label for a flagged stage', () => {
    const appModel = makeAppModel([1]);
    const catalog = [tinyTaskFinding(1, 42)];
    render(<TinyTask appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);

    expect(screen.getByRole('heading', { name: 'Tiny Tasks' })).toBeInTheDocument();
    expect(screen.getByText('TINY')).toBeInTheDocument();
    expect(screen.getByText('P50 42ms across many small tasks')).toBeInTheDocument();
  });

  it('flags every affected stage, not just the worst', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1, 2]);
    const catalog = [tinyTaskFinding(1, 42), tinyTaskFinding(2, 55)];
    render(<TinyTask appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);
    await user.click(screen.getByRole('button', { name: /^tiny tasks$/i }));

    expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
  });

  it('renders nothing when the catalog has no tinyTask findings', () => {
    const appModel = makeAppModel([1]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning', metric: 'ratio', value: 8 }];
    const { container } = render(<TinyTask appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a straggler-share callout on a flagged stage\'s row, same as Skew.tsx (constraint: preserved on all three siblings)', () => {
    const appModel = makeAppModel([1]);
    const catalog = [tinyTaskFinding(1, 42), stragglerFinding(1, 15)];
    render(<TinyTask appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);

    expect(screen.getByText('Stragglers:')).toBeInTheDocument();
    expect(screen.getByText(/15% of tasks > 4× P50/)).toBeInTheDocument();
  });

  it('expanding a row lazily awaits getTaskData and shows the duration histogram', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1]);
    const catalog = [tinyTaskFinding(1, 42)];
    const getTaskData = vi.fn(async () => TASK_DATA);
    render(<TinyTask appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    await user.click(screen.getByRole('button', { name: /^tiny tasks$/i }));

    expect(getTaskData).not.toHaveBeenCalled();
    expect(screen.queryByText('Task duration')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show task detail for stage 1/i }));

    expect(getTaskData).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Task duration')).toBeInTheDocument();
  });

  it('renders a PlanExplorer for an expanded row\'s stage at Advanced density when the stage has a linked plan', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    const planTree = { name: 'Scan parquet', detail: 'FileScan parquet', metrics: [], children: [] };
    const appModel: AppModel = {
      ...makeAppModel([1]),
      stages: new Map([[1, { id: 1, name: 'sql-scan-1', taskDurationP50: 40, taskDurationP95: 60, taskDurationMax: 90, sqlExecutionId: 1 }]]) as unknown as AppModel['stages'],
      sql: new Map([[1, { executionId: 1, physicalPlanDescription: '', planTree }]]) as unknown as AppModel['sql'],
    };
    const catalog = [tinyTaskFinding(1, 42)];

    render(<TinyTask appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);
    await user.click(screen.getByRole('button', { name: /^tiny tasks$/i }));
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
      stages: new Map([[1, { id: 1, name: 'sql-scan-1', taskDurationP50: 40, taskDurationP95: 60, taskDurationMax: 90, sqlExecutionId: 1 }]]) as unknown as AppModel['stages'],
      sql: new Map([[1, { executionId: 1, physicalPlanDescription: '', planTree }]]) as unknown as AppModel['sql'],
    };
    const catalog = [tinyTaskFinding(1, 42)];

    render(<TinyTask appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);
    await user.click(screen.getByRole('button', { name: /^tiny tasks$/i }));
    await user.click(screen.getByRole('button', { name: /show task detail for stage 1/i }));

    expect(await screen.findByText('Task duration')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plan context' })).not.toBeInTheDocument();
  });

  it('renders the impact estimate for a flagged tinyTask finding', () => {
    const appModel = makeAppModel([1]);
    const finding: Finding = {
      ...tinyTaskFinding(1, 42),
      impactEstimate: { basis: 'serial', wallClock: { low: 300, high: 300 }, estimateMethod: 'measured', rawWaste: { value: 300, unit: 'ms' } },
    };
    render(<TinyTask appModel={appModel} catalog={[finding]} getTaskData={vi.fn(async () => TASK_DATA)} />);
    expect(screen.getByText('300ms')).toBeInTheDocument();
  });
});
