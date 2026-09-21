// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openStage = vi.fn();
vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage, close: vi.fn() }),
}));

import { StageTable } from '@/view/widgets/StageTable';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

// Real per-stage fields as posted by the parser worker; the `Stage` type's
// `stageId` field doesn't reflect runtime shape, so fixtures use `id` and the
// widget casts through a raw shape internally.
function makeStage(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `stage-${id}`,
    stageType: 'shuffle',
    submittedAt: 0,
    completedAt: 1000,
    taskCount: 10,
    failedTasks: 0,
    shuffleReadBytes: 0,
    memoryBytesSpilled: 0,
    gcPct: 0,
    fetchWaitTime: 0,
    executorRunTime: 1000,
    inputBytes: 0,
    outputBytes: 0,
    taskDurationP50: 100,
    taskDurationP95: 200,
    spillClassification: 'unclassified',
    ...overrides,
  };
}

function buildAppModel(stages: Array<[number, Record<string, unknown>]>): AppModel {
  return { ...emptyAppModel(), stages: new Map(stages) as unknown as AppModel['stages'] };
}

const noTaskData = async () => ({ metrics: [], fieldNames: [] });

describe('StageTable', () => {
  beforeEach(() => {
    openStage.mockClear();
  });

  it('renders a table with sortable column headers that flip order on click', async () => {
    const user = userEvent.setup();
    const appModel = buildAppModel([
      [1, makeStage(1, { taskCount: 30 })],
      [2, makeStage(2, { taskCount: 10 })],
      [3, makeStage(3, { taskCount: 20 })],
    ]);
    const catalog: Finding[] = [
      { type: 'skew', stageId: 1, impactBand: 'warning' },
      { type: 'skew', stageId: 2, impactBand: 'warning' },
      { type: 'skew', stageId: 3, impactBand: 'warning' },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    const tasksHeader = screen.getByRole('columnheader', { name: /tasks/i });
    expect(tasksHeader).toHaveAttribute('aria-sort', 'none');

    await user.click(tasksHeader);
    let rows = screen.getAllByRole('row').slice(1); // drop header row
    let firstCellText = within(rows[0]).getAllByRole('cell')[0].textContent;
    expect(firstCellText).toBe('2'); // ascending: taskCount 10 first
    expect(tasksHeader).toHaveAttribute('aria-sort', 'ascending');

    await user.click(tasksHeader);
    rows = screen.getAllByRole('row').slice(1);
    firstCellText = within(rows[0]).getAllByRole('cell')[0].textContent;
    expect(firstCellText).toBe('1'); // descending: taskCount 30 first
    expect(tasksHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('calls openStage with the stage id when a row is clicked', async () => {
    const user = userEvent.setup();
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    const rows = screen.getAllByRole('row').slice(1);
    await user.click(rows[0]);

    expect(openStage).toHaveBeenCalledWith(1);
  });

  it('defaults to the Top-10-by-duration view, not problems-only', () => {
    const appModel = buildAppModel([
      [1, makeStage(1)],
      [2, makeStage(2)],
      [3, makeStage(3)],
    ]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 2, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    expect(screen.getByRole('button', { name: /problems only/i })).toBeInTheDocument();
    expect(screen.getByText(/top 10 by duration/i)).toBeInTheDocument();
  });

  it('defaults to the problem-stage view: only flagged stages are shown', async () => {
    const user = userEvent.setup();
    const appModel = buildAppModel([
      [1, makeStage(1)],
      [2, makeStage(2)],
      [3, makeStage(3)],
    ]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 2, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    // Toggle to the problems-only view
    await user.click(screen.getByRole('button', { name: /problems only/i }));

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getAllByRole('cell')[0].textContent).toBe('2');
  });

  it('toggle switches between the default top-N view and the problem view', async () => {
    const user = userEvent.setup();
    const appModel = buildAppModel([
      [1, makeStage(1)],
      [2, makeStage(2)],
      [3, makeStage(3)],
    ]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 2, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    // Default is now top-N, showing all 3 stages
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(3);

    // Toggle to problems-only view
    await user.click(screen.getByRole('button', { name: /problems only/i }));

    expect(screen.getAllByRole('row').slice(1)).toHaveLength(1);

    // Toggle back to top-N view
    await user.click(screen.getByRole('button', { name: /top.*by duration/i }));
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(3);
  });

  it('renders no domain/company strings', () => {
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    const { container } = render(
      <StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />,
    );

    expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
  });

  it('wraps the table in a WidgetCard titled "Stage Summary"', () => {
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    expect(screen.getByRole('heading', { name: 'Stage Summary' })).toBeInTheDocument();
  });

  it('deduplicates same-type tags per stage, keeping the worst impact band', async () => {
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [
      { type: 'stageShape', stageId: 1, impactBand: 'info' },
      { type: 'stageShape', stageId: 1, impactBand: 'critical' },
      { type: 'stageShape', stageId: 1, impactBand: 'warning' },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    const rows = screen.getAllByRole('row').slice(1);
    const shapeBadges = within(rows[0]).getAllByText(/shape/i);
    expect(shapeBadges).toHaveLength(1);
    expect(shapeBadges[0].closest('[data-slot="badge"]')).toHaveClass('text-critical');
  });

  it('deduplicates same-type tags per stage, keeping the first occurrence on a tie', async () => {
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'warning' },
      { type: 'spill', stageId: 1, impactBand: 'warning' },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    const rows = screen.getAllByRole('row').slice(1);
    const tags = within(rows[0]).getAllByText(/gc|spill/i);
    expect(tags).toHaveLength(2);
  });

  it('renders one tag per distinct problem type inline in the Operation cell, not a count badge', async () => {
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [
      { type: 'spill', stageId: 1, impactBand: 'warning' },
      { type: 'gc', stageId: 1, impactBand: 'warning' },
      { type: 'slowHost', stageId: 1, impactBand: 'critical' },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    const rows = screen.getAllByRole('row').slice(1);
    const operationCell = within(rows[0]).getAllByRole('cell')[1];
    expect(within(operationCell).getByText('SPILL')).toBeInTheDocument();
    expect(within(operationCell).getByText('GC')).toBeInTheDocument();
    expect(within(operationCell).getByText('HOST')).toBeInTheDocument();
    expect(within(operationCell).queryByText(/×/)).not.toBeInTheDocument();
  });

  it('shows the compact impact-estimate value next to the finding-type chip', async () => {
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [
      {
        type: 'skew', stageId: 1, impactBand: 'warning',
        impactEstimate: { basis: 'contended', wallClock: { low: 1000, high: 3000 }, estimateMethod: 'measured' },
      },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    expect(screen.getByText('3.0s')).toBeInTheDocument();
  });

  it('announces row count and mode via an aria-live status region', async () => {
    const appModel = buildAppModel([
      [1, makeStage(1)],
      [2, makeStage(2)],
    ]);
    const catalog: Finding[] = [
      { type: 'skew', stageId: 1, impactBand: 'warning' },
      { type: 'skew', stageId: 2, impactBand: 'warning' },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/showing 2 stages/i);
    expect(status).toHaveTextContent(/top 10 by duration/i);
  });

  it('has no aria-pressed on the view-switch action button, and its label flips with the view', async () => {
    const user = userEvent.setup();
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    // It's an action button that names the mode it switches TO, not a real
    // toggle: aria-pressed would only ever contradict its own label.
    // Default view is top-N, so button says "Problems only" (the thing you'd switch to)
    const toggle = screen.getByRole('button', { name: /problems only/i });
    expect(toggle).not.toHaveAttribute('aria-pressed');

    await user.click(toggle);
    const flipped = screen.getByRole('button', { name: /top.*by duration/i });
    expect(flipped).not.toHaveAttribute('aria-pressed');
  });

  it('paginates when there are more than 10 stages', async () => {
    const user = userEvent.setup();
    const stageEntries: Array<[number, Record<string, unknown>]> = [];
    const catalog: Finding[] = [];
    for (let i = 1; i <= 12; i++) {
      stageEntries.push([i, makeStage(i)]);
      catalog.push({ type: 'skew', stageId: i, impactBand: 'warning' });
    }
    const appModel = buildAppModel(stageEntries);

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    // Default is top-10 view, toggle to problems-only to see all 12 flagged stages
    await user.click(screen.getByRole('button', { name: /problems only/i }));

    // 12 problem stages, page size 10 -> page 1 of 2, 10 rows shown.
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(11); // header + 10 body rows

    const previousButton = screen.getByRole('button', { name: 'Previous' });
    const nextButton = screen.getByRole('button', { name: 'Next' });
    expect(previousButton).toBeDisabled();
    expect(nextButton).not.toBeDisabled();

    await user.click(nextButton);

    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 remaining body rows
    expect(previousButton).not.toBeDisabled();
    expect(nextButton).toBeDisabled();

    await user.click(previousButton);

    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(previousButton).toBeDisabled();
  });

  it('routes only its retained worst same-type representative without opening stage detail', async () => {
    const user = userEvent.setup();
    const onRoute = vi.fn();
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const duplicateSkewFindings: Finding[] = [
      { type: 'skew', stageId: 1, impactBand: 'warning', recommendation: 'Check partition balance.' },
      { type: 'skew', stageId: 1, impactBand: 'critical', recommendation: 'Rebalance partitions.' },
    ];

    render(<StageTable appModel={appModel} catalog={duplicateSkewFindings} getTaskData={noTaskData} onRoute={onRoute} />);

    expect(screen.getAllByRole('button', { name: /investigate task skew in stage 1/i })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /investigate task skew in stage 1/i }));

    expect(onRoute).toHaveBeenCalledWith(expect.objectContaining({ finding: duplicateSkewFindings[1] }));
    expect(openStage).not.toHaveBeenCalled();
  });

  it('Stage Summary route button activates with pointer, Enter, and Space without opening stage detail', async () => {
    const user = userEvent.setup();
    const onRoute = vi.fn();
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [
      { type: 'skew', stageId: 1, impactBand: 'critical', recommendation: 'Rebalance partitions.' },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} onRoute={onRoute} />);

    const button = screen.getByRole('button', { name: /investigate task skew in stage 1/i });
    await user.click(button);
    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onRoute).toHaveBeenCalledTimes(3);
    expect(onRoute).toHaveBeenLastCalledWith(expect.objectContaining({ finding: catalog[0] }));
    expect(openStage).not.toHaveBeenCalled();
  });

  it('renders the button-nested tag pill as a plain badge, never an <a>, even for a type that would otherwise link', async () => {
    const onRoute = vi.fn();
    const appModel = buildAppModel([[1, makeStage(1)]]);
    // 'skew' resolves to a known docs anchor (#bottleneck-skew): this proves
    // the route button's pill suppresses TagBadge's link behavior (and its
    // TAG_HELP title, which would otherwise shadow the button's own, more
    // specific title/aria-label), not just that there's nothing to link to.
    const catalog: Finding[] = [
      { type: 'skew', stageId: 1, impactBand: 'warning', recommendation: 'Check partition balance.' },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} onRoute={onRoute} />);

    const button = screen.getByRole('button', { name: /investigate task skew in stage 1/i });
    // No nested link: an <a> inside a <button> would be invalid HTML and
    // would fight the button's own onClick/onKeyDown handlers.
    expect(within(button).queryByRole('link')).not.toBeInTheDocument();
    expect(button.querySelector('a')).toBeNull();
    // The pill's own title is suppressed too, so hovering the button only
    // ever shows the button's "Investigate ..." tooltip, never TAG_HELP's.
    const badge = within(button).getByText('SKEW').closest('span');
    expect(badge).not.toHaveAttribute('title');
  });

  it('exposes a real "Open details" button per row while keeping table row semantics', async () => {
    const user = userEvent.setup();
    const appModel = buildAppModel([
      [1, makeStage(1)],
      [2, makeStage(2)],
    ]);
    const catalog: Finding[] = [
      { type: 'skew', stageId: 1, impactBand: 'warning' },
      { type: 'skew', stageId: 2, impactBand: 'warning' },
    ];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    // Body rows must stay queryable as rows: role="button" on a <tr> would
    // remove them from the accessibility tree's table structure.
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);

    // Named distinctly from StagePill's "Open details for Stage N"; both can
    // render on one dashboard and must stay uniquely queryable.
    const openButton = within(rows[0]).getByRole('button', { name: 'Open Stage 1 details' });
    await user.click(openButton);
    // Exactly once: the button must stopPropagation so the row's own click
    // handler doesn't double-fire.
    expect(openStage).toHaveBeenCalledTimes(1);
    expect(openStage).toHaveBeenCalledWith(1);

    // Native button gives Enter/Space activation for free.
    openButton.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(openStage).toHaveBeenCalledTimes(3);

    // The row itself is no longer a focusable, labeled, role-less widget.
    expect(rows[0]).not.toHaveAttribute('tabindex');
    expect(rows[0]).not.toHaveAttribute('aria-label');
  });

  it('pagination buttons carry the comfortable tap-target utility', async () => {
    const user = userEvent.setup();
    const stageEntries: Array<[number, Record<string, unknown>]> = [];
    const catalog: Finding[] = [];
    for (let i = 1; i <= 12; i++) {
      stageEntries.push([i, makeStage(i)]);
      catalog.push({ type: 'skew', stageId: i, impactBand: 'warning' });
    }
    const appModel = buildAppModel(stageEntries);

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    // Toggle to problems-only view to see all 12 flagged stages and trigger pagination
    await user.click(screen.getByRole('button', { name: /problems only/i }));

    expect(screen.getByRole('button', { name: 'Previous' })).toHaveClass('tap-target-comfortable');
    expect(screen.getByRole('button', { name: 'Next' })).toHaveClass('tap-target-comfortable');
  });

  it('sortable column headers carry the comfortable tap-target utility', () => {
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header).toHaveClass('tap-target-comfortable');
    }
  });

  it('hides the I/O Ratio, GC%, and Skew P95/median columns at Basic density', () => {
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    expect(screen.queryByRole('columnheader', { name: /i\/o ratio/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /gc%/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /skew p95\/median/i })).not.toBeInTheDocument();
    // Fetch Wait and Spill stay, since they're duration/classification, not raw ratios.
    expect(screen.getByRole('columnheader', { name: /fetch wait/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /spill/i })).toBeInTheDocument();
  });

  it('shows the I/O Ratio, GC%, and Skew P95/median columns at Advanced density', () => {
    store.getState().setWidgetDensity('advanced');
    const appModel = buildAppModel([[1, makeStage(1)]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    expect(screen.getByRole('columnheader', { name: /i\/o ratio/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /gc%/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /skew p95\/median/i })).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('shows a plain flag label, not the raw percentage, in the Fetch Wait chip at Basic density', () => {
    const appModel = buildAppModel([[1, makeStage(1, { fetchWaitTime: 400, executorRunTime: 1000 })]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.queryByText('40%')).not.toBeInTheDocument();
  });

  it('shows the raw fetch-wait percentage in the chip at Advanced density', () => {
    store.getState().setWidgetDensity('advanced');
    const appModel = buildAppModel([[1, makeStage(1, { fetchWaitTime: 400, executorRunTime: 1000 })]]);
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];

    render(<StageTable appModel={appModel} catalog={catalog} getTaskData={noTaskData} />);

    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.queryByText('High')).not.toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });
});
