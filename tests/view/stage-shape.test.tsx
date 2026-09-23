// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { StageShape } from '@/view/widgets/StageShape';
import { store } from '@/store/store';
import type { AppModel, Finding, TaskData } from '@sparkforensics/core/types.ts';

function makeAppModel(stageIds: number[]): AppModel {
  const stages = new Map<number, unknown>(
    stageIds.map((id) => [id, { id, name: `sql-scan-${id}`, taskDurationP50: 100, taskDurationP95: 500, taskDurationMax: 900 }]),
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

function stageShapeFinding(
  stageId: number,
  rule: string,
  value: number,
  impactBand: Finding['impactBand'] = 'info',
): Finding {
  return { type: 'stageShape', stageId, impactBand, rule, metric: rule, value, recommendation: 'r' };
}

function slowHostFinding(stageId: number, host: string, ratio: number, hostTaskShare: number): Finding {
  return {
    type: 'slowHost', stageId, impactBand: 'warning', metric: 'hostMeanRatio', value: ratio, host, hostTaskShare,
    recommendation: 'r',
  };
}

const TASK_DATA: TaskData = {
  metrics: [100, 0, 200, 0, 300, 0, 400, 0, 500, 0, 600, 0],
  fieldNames: ['duration', 'gcTime'],
};

describe('StageShape', () => {
  it('renders the WidgetCard heading and a row for every flagged stage', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1]);
    const catalog = [stageShapeFinding(1, 'lowParallelism', 0.3)];
    render(<StageShape appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);

    expect(screen.getByRole('heading', { name: 'Stage Shape' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^stage shape$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
  });

  it('renders a rule-specific label per stageShape rule', () => {
    const appModel = makeAppModel([1, 2, 3]);
    const catalog = [
      stageShapeFinding(1, 'lowParallelism', 0.3),
      stageShapeFinding(2, 'dataExplosion', 12),
      stageShapeFinding(3, 'taskStageSkew', 6),
    ];
    render(<StageShape appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);

    expect(screen.getByText('Low parallelism: 0.3')).toBeInTheDocument();
    expect(screen.getByText('Data explosion: 12')).toBeInTheDocument();
    expect(screen.getByText('Task/stage skew: 6')).toBeInTheDocument();
  });

  it('shows the SHAPE tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
    const appModel = makeAppModel([1, 2]);
    const catalog = [stageShapeFinding(1, 'lowParallelism', 0.3), stageShapeFinding(2, 'dataExplosion', 12)];
    const { container } = render(
      <StageShape appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />,
    );

    expect(screen.getByText('SHAPE')).toBeInTheDocument();
    // One dot inside the header TagBadge itself, plus one per flagged stage row.
    expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
  });

  it('renders nothing when the catalog has no stageShape findings', () => {
    const appModel = makeAppModel([1]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning', metric: 'ratio', value: 8 }];
    const { container } = render(<StageShape appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a slow-host callout on a flagged stage\'s row, same as Skew.tsx (constraint: preserved on all three siblings)', () => {
    const appModel = makeAppModel([1]);
    const catalog = [stageShapeFinding(1, 'lowParallelism', 0.3), slowHostFinding(1, 'worker-3', 3.5, 0.4)];
    render(<StageShape appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);

    expect(screen.getByText('Slow host:')).toBeInTheDocument();
    expect(screen.getByText(/worker-3 \(3\.5× median, 40% of tasks\)/)).toBeInTheDocument();
  });

  it('expanding a row lazily awaits getTaskData and shows the duration histogram', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel([1]);
    const catalog = [stageShapeFinding(1, 'lowParallelism', 0.3)];
    const getTaskData = vi.fn(async () => TASK_DATA);
    render(<StageShape appModel={appModel} catalog={catalog} getTaskData={getTaskData} />);

    await user.click(screen.getByRole('button', { name: /^stage shape$/i }));
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
      stages: new Map([[1, { id: 1, name: 'sql-scan-1', taskDurationP50: 100, taskDurationP95: 500, taskDurationMax: 900, sqlExecutionId: 1 }]]) as unknown as AppModel['stages'],
      sql: new Map([[1, { executionId: 1, planTree }]]) as unknown as AppModel['sql'],
    };
    const catalog = [stageShapeFinding(1, 'lowParallelism', 0.3)];

    render(<StageShape appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);
    await user.click(screen.getByRole('button', { name: /^stage shape$/i }));
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
      stages: new Map([[1, { id: 1, name: 'sql-scan-1', taskDurationP50: 100, taskDurationP95: 500, taskDurationMax: 900, sqlExecutionId: 1 }]]) as unknown as AppModel['stages'],
      sql: new Map([[1, { executionId: 1, planTree }]]) as unknown as AppModel['sql'],
    };
    const catalog = [stageShapeFinding(1, 'lowParallelism', 0.3)];

    render(<StageShape appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);
    await user.click(screen.getByRole('button', { name: /^stage shape$/i }));
    await user.click(screen.getByRole('button', { name: /show task detail for stage 1/i }));

    expect(await screen.findByText('Task duration')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plan context' })).not.toBeInTheDocument();
  });

  it('paginates the stage list 6-at-a-time', async () => {
    const user = userEvent.setup();
    const stageIds = [1, 2, 3, 4, 5, 6, 7];
    const appModel = makeAppModel(stageIds);
    const catalog = stageIds.map((id) => stageShapeFinding(id, 'lowParallelism', 0.3));
    render(<StageShape appModel={appModel} catalog={catalog} getTaskData={vi.fn(async () => TASK_DATA)} />);
    await user.click(screen.getByRole('button', { name: /^stage shape$/i }));

    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });
});
