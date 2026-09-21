// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StageDetailDialog } from '@/view/widgets/StageDetailDialog';
import { StageDetailProvider, useStageDetail } from '@/view/StageDetailContext';
import { DocsProvider } from '@/view/DocsContext';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel, Finding, PlanNode, TaskData } from '@sparkforensics/core/types.ts';

function makeStage(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'sql-scan-1',
    submittedAt: 1_000,
    completedAt: 5_000,
    sqlExecutionId: null,
    taskCount: 10,
    failedTasks: 0,
    taskDurationP50: 100,
    taskDurationP95: 300,
    taskDurationMax: 400,
    inputBytes: 1024,
    outputBytes: 512,
    shuffleReadBytes: 0,
    shuffleWriteBytes: 0,
    fetchWaitTime: 0,
    memoryBytesSpilled: 0,
    diskBytesSpilled: 0,
    jvmGCTime: 0,
    executorRunTime: 4_000,
    gcPct: 0,
    ...overrides,
  };
}

function makeAppModel(
  stage: ReturnType<typeof makeStage> = makeStage(),
  sql?: Map<number, { executionId: number; planTree?: PlanNode | null; stageIds?: number[] }>,
): AppModel {
  return {
    ...emptyAppModel(),
    stages: new Map([[stage.id, stage]]) as unknown as AppModel['stages'],
    ...(sql ? { sql: sql as unknown as AppModel['sql'] } : {}),
  };
}

const TASK_DATA: TaskData = {
  metrics: [100, 200, 300, 400, 500, 600],
  fieldNames: ['duration'],
};

function OpenButton({ stageId = 1 }: { stageId?: number }) {
  const { openStage } = useStageDetail();
  return <button onClick={() => openStage(stageId)}>open stage {stageId}</button>;
}

function renderHarness(
  appModel: AppModel,
  getTaskData = vi.fn(async () => TASK_DATA),
  catalog: Finding[] = [],
) {
  render(
    <DocsProvider>
      <StageDetailProvider>
        <OpenButton />
        <StageDetailDialog appModel={appModel} catalog={catalog} getTaskData={getTaskData} />
      </StageDetailProvider>
    </DocsProvider>,
  );
  return { getTaskData };
}

describe('StageDetailDialog', () => {
  it('renders nothing until openStage is called', () => {
    renderHarness(makeAppModel());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens with a dialog role and the stage id + name heading when openStage is called', async () => {
    const user = userEvent.setup();
    renderHarness(makeAppModel());

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /stage 1/i })).toBeInTheDocument();
    expect(within(dialog).getByText(/sql-scan-1/)).toBeInTheDocument();
  });

  it('closes on Escape (Radix/base-ui owns the key handling)', async () => {
    const user = userEvent.setup();
    renderHarness(makeAppModel());

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows Overview and Tasks metrics for the open stage', async () => {
    const user = userEvent.setup();
    renderHarness(makeAppModel());

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('4.0s')).toBeInTheDocument(); // duration: 5000-1000ms
    expect(within(dialog).getByText('10')).toBeInTheDocument(); // total tasks
    expect(within(dialog).getByText('100ms')).toBeInTheDocument(); // P50
  });

  it('renders Overview expanded by default, unlike every other section', async () => {
    const user = userEvent.setup();
    renderHarness(makeAppModel());

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('lazily fetches task data on open and renders the duration histogram once it resolves', async () => {
    const user = userEvent.setup();
    const getTaskData = vi.fn(async () => TASK_DATA);
    renderHarness(makeAppModel(), getTaskData);

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    await screen.findByRole('dialog');

    expect(getTaskData).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Task duration')).toBeInTheDocument();
  });

  it('shows an unavailable message instead of hanging on "Loading" when getTaskData rejects', async () => {
    const user = userEvent.setup();
    const getTaskData = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    renderHarness(makeAppModel(), getTaskData);

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    await screen.findByRole('dialog');

    expect(await screen.findByText(/couldn.t load task data/i)).toBeInTheDocument();
    expect(screen.queryByText(/loading task data/i)).not.toBeInTheDocument();
  });

  it('shows an honest export-mode message instead of fetching task data, with no Retry button', async () => {
    const user = userEvent.setup();
    const getTaskData = vi.fn(async () => TASK_DATA);
    store.setState({ exportMode: true });

    renderHarness(makeAppModel(), getTaskData);
    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText(/isn.t included in exported reports/i)).toBeInTheDocument();
    expect(getTaskData).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    store.setState({ exportMode: false });
  });

  it('renders a locality section with a chart image when the stage has locality stats', async () => {
    const user = userEvent.setup();
    const stage = makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 8 },
        { locality: 'ANY', count: 2 },
      ],
    });
    renderHarness(makeAppModel(stage));

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    // Every section in this dialog is collapsed by default: expand it first.
    await user.click(within(dialog).getByRole('button', { name: 'Locality' }));

    expect(within(dialog).getByRole('heading', { name: 'Locality' })).toBeInTheDocument();
    expect(within(dialog).getAllByText('PROCESS_LOCAL').length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('img', { name: /task locality distribution/i })).toBeInTheDocument();
  });

  it('exposes a locality data table matching the chart, inside the dialog', async () => {
    const user = userEvent.setup();
    const stage = makeStage({
      localityStats: [
        { locality: 'PROCESS_LOCAL', count: 8 },
        { locality: 'ANY', count: 2 },
      ],
    });
    renderHarness(makeAppModel(stage));

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    // Every section in this dialog is collapsed by default: expand it first.
    await user.click(within(dialog).getByRole('button', { name: 'Locality' }));
    const localitySection = within(dialog)
      .getByRole('heading', { name: 'Locality' })
      .closest<HTMLElement>('[data-slot="collapsible"]')!;

    await user.click(within(localitySection).getByRole('button', { name: /table/i }));

    expect(within(localitySection).getByRole('columnheader', { name: 'Locality tier' })).not.toHaveClass(
      'text-right',
    );
    expect(within(localitySection).getByRole('columnheader', { name: 'Task count' })).toHaveClass('text-right');
  });

  it('omits the Locality section when the stage has no locality stats', async () => {
    const user = userEvent.setup();
    renderHarness(makeAppModel());

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByRole('heading', { name: 'Locality' })).not.toBeInTheDocument();
  });

  it('shows the Spill section only when the stage actually spilled', async () => {
    const user = userEvent.setup();
    const stage = makeStage({ memoryBytesSpilled: 600 * 1024 * 1024, spillClassification: 'volume' });
    renderHarness(makeAppModel(stage));

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('heading', { name: 'Spill' })).toBeInTheDocument();
    expect(within(dialog).getByText('volume')).toBeInTheDocument();
  });

  it('omits the Spill section when nothing spilled', async () => {
    const user = userEvent.setup();
    renderHarness(makeAppModel());

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByRole('heading', { name: 'Spill' })).not.toBeInTheDocument();
  });

  it('shows the GC section only when GC time was recorded', async () => {
    const user = userEvent.setup();
    const stage = makeStage({ jvmGCTime: 500, gcPct: 12.5 });
    renderHarness(makeAppModel(stage));

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('heading', { name: 'GC' })).toBeInTheDocument();
    expect(within(dialog).getByText('12.5%')).toBeInTheDocument();
  });

  it('renders the call-stack details at Advanced density, only when the stage carries them', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    const stage = makeStage({ details: 'org.apache.spark.rdd.RDD.map(RDD.scala:100)' });
    renderHarness(makeAppModel(stage));

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Call Stack')).toBeInTheDocument();
    expect(within(dialog).getByText(/RDD\.scala:100/)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('hides the call-stack details at Basic density even when the stage carries them', async () => {
    const user = userEvent.setup();
    const stage = makeStage({ details: 'org.apache.spark.rdd.RDD.map(RDD.scala:100)' });
    renderHarness(makeAppModel(stage));

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByText('Call Stack')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/RDD\.scala:100/)).not.toBeInTheDocument();
  });

  it('renders a verdict section with a chip and recommendation per flagged finding type, before Overview', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [
      { type: 'shuffle', stageId: 1, impactBand: 'warning', recommendation: 'Increase shuffle partitions.' },
      {
        type: 'skew',
        stageId: 1,
        impactBand: 'critical',
        recommendation: 'Rebalance partitioning.',
        docAnchor: '#bottleneck-skew',
      },
    ];
    renderHarness(makeAppModel(), vi.fn(async () => TASK_DATA), catalog);

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('SHFL')).toBeInTheDocument();
    expect(within(dialog).getByText('SKEW')).toBeInTheDocument();
    expect(within(dialog).getByText('Increase shuffle partitions.')).toBeInTheDocument();
    expect(within(dialog).getByText('Rebalance partitioning.')).toBeInTheDocument();
    // No separate "Learn more" link: the SKEW chip itself already links to
    // the same docs anchor the finding carries.
    expect(within(dialog).queryByRole('link', { name: 'Learn more →' })).not.toBeInTheDocument();
    const skewLink = within(dialog).getByRole('link', { name: 'SKEW' });
    expect(skewLink.getAttribute('href')).toContain('#bottleneck-skew');
  });

  it('shows the full range unconditionally, with no compact figure and no disclosure to open', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [
      {
        type: 'skew', stageId: 1, impactBand: 'warning', recommendation: 'Investigate skew',
        impactEstimate: { basis: 'contended', wallClock: { low: 1000, high: 3000 }, estimateMethod: 'measured' },
      },
    ];
    renderHarness(makeAppModel(), vi.fn(async () => TASK_DATA), catalog);

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('1.0s-3.0s')).toBeInTheDocument();
    expect(within(dialog).queryByText('3.0s')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^more$/i)).not.toBeInTheDocument();
  });

  it('renders no impact estimate for a purely informational finding, on top of its always-visible recommendation', async () => {
    // stageFailed/failures resolve to basis: 'informational' (src/impact-estimator.ts):
    // no extended text either, so there is nothing beyond the recommendation to show.
    const catalog: Finding[] = [
      {
        type: 'stageFailed', stageId: 1, impactBand: 'critical', recommendation: 'Inspect the driver log.',
        impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' },
      },
    ];
    renderHarness(makeAppModel(), vi.fn(async () => TASK_DATA), catalog);

    await userEvent.setup().click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Inspect the driver log.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/^more$/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/potential savings/i)).not.toBeInTheDocument();
  });

  it('omits the verdict section when the stage has no findings', async () => {
    const user = userEvent.setup();
    renderHarness(makeAppModel());

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByText('SHFL')).not.toBeInTheDocument();
  });

  it('renders the hierarchical plan tree without attaching per-node finding badges', async () => {
    const user = userEvent.setup();
    const planTree: PlanNode = {
      name: 'Exchange hashpartitioning',
      detail: 'Exchange hashpartitioning',
      metrics: [],
      children: [
        {
          name: 'SortMergeJoin',
          detail: 'SortMergeJoin',
          metrics: [],
          children: [],
        },
      ],
    };
    const sql = new Map([[7, { executionId: 7, planTree, stageIds: [1] }]]);
    const stage = makeStage({ sqlExecutionId: 7 });
    const appModel = makeAppModel(stage, sql);
    const catalog: Finding[] = [
      { type: 'shuffle', stageId: 1, impactBand: 'warning' },
      { type: 'skew', stageId: 1, impactBand: 'critical' },
    ];
    renderHarness(appModel, vi.fn(async () => TASK_DATA), catalog);

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('heading', { name: 'Query Plan' })).toBeInTheDocument();
    expect(within(dialog).getByText('SortMergeJoin')).toBeInTheDocument();

    const exchangeSummary = within(dialog).getByText('Exchange hashpartitioning').closest('summary') as HTMLElement;
    const joinSummary = within(dialog).getByText('SortMergeJoin').closest('summary') as HTMLElement;

    expect(exchangeSummary.textContent).not.toContain('SHFL');
    expect(joinSummary.textContent).not.toContain('SKEW');
  });

  it('omits the plan tree when the stage has no linked SQL execution', async () => {
    const user = userEvent.setup();
    renderHarness(makeAppModel());

    await user.click(screen.getByRole('button', { name: 'open stage 1' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByRole('heading', { name: 'Query Plan' })).not.toBeInTheDocument();
  });
});
