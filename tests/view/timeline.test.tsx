// @vitest-environment jsdom
import { test, describe, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { StageDetailDialog } from '@/view/widgets/StageDetailDialog';
import { Timeline, selectTimelineStages } from '@/view/widgets/Timeline';
import type { AppModel, Finding, TaskData } from '@sparkforensics/core/types.ts';

function renderTimeline(appModel: AppModel, catalog: Finding[] = []) {
  return render(
    <StageDetailProvider>
      <Timeline appModel={appModel} catalog={catalog} />
    </StageDetailProvider>,
  );
}

// Real per-stage fields as posted by the parser worker; the `Stage` type's
// `stageId` field doesn't reflect runtime shape, so the fixture bridges the
// type gap with a cast, same as the widget itself does.
function makeStage(id: number, submittedAt: number, completedAt: number) {
  return { id, name: `s${id}`, submittedAt, completedAt };
}

function buildAppModel(stages: Map<number, unknown>): AppModel {
  return { ...emptyAppModel(), stages: stages as unknown as AppModel['stages'] };
}

beforeEach(() => {
  store.getState().setWidgetDensity('basic');
});

describe('selectTimelineStages (ported from src/widgets/timeline.js)', () => {
  test('returns all stages sorted by start when under the cap', () => {
    const input = [makeStage(2, 200, 300), makeStage(1, 100, 150)];
    const { stages, total, capped } = selectTimelineStages(input, 20);
    expect(capped).toBe(false);
    expect(total).toBe(2);
    expect(stages.map((s) => s.id)).toEqual([1, 2]);
  });

  test('caps to the top-N longest stages then restores chronological order', () => {
    const input = [];
    for (let i = 1; i <= 25; i++) input.push(makeStage(i, i * 100, i * 100 + i * 10));
    const { stages, total, capped } = selectTimelineStages(input, 20);
    expect(capped).toBe(true);
    expect(total).toBe(25);
    expect(stages.length).toBe(20);
    expect(stages[0].id).toBe(6);
    expect(stages[19].id).toBe(25);
  });

  test('ignores stages missing submit or complete timestamps', () => {
    const input = [makeStage(1, 0, 0), makeStage(2, 100, 200)];
    const { stages, total } = selectTimelineStages(input, 20);
    expect(total).toBe(1);
    expect(stages.map((s) => s.id)).toEqual([2]);
  });
});

describe('Timeline widget', () => {
  test('renders the WidgetCard heading', () => {
    const stages = new Map([[1, makeStage(1, 100, 200)], [2, makeStage(2, 200, 300)]]);
    renderTimeline(buildAppModel(stages));
    expect(screen.getByRole('heading', { name: /job timeline/i })).toBeInTheDocument();
  });

  test('renders a chart region for the stage bars', () => {
    const stages = new Map([[1, makeStage(1, 100, 200)], [2, makeStage(2, 200, 300)]]);
    renderTimeline(buildAppModel(stages));
    expect(screen.getByRole('img', { name: /job timeline/i })).toBeInTheDocument();
  });

  test('exposes a data table with one row per plotted stage bar', async () => {
    const user = userEvent.setup();
    const stages = new Map([[1, makeStage(1, 100, 200)], [2, makeStage(2, 200, 300)]]);
    renderTimeline(buildAppModel(stages));

    await user.click(screen.getByRole('button', { name: /table/i }));

    expect(screen.getByRole('columnheader', { name: 'Stage' })).not.toHaveClass('text-right');
    expect(screen.getByRole('columnheader', { name: 'Start' })).toHaveClass('text-right');
    expect(screen.getByRole('columnheader', { name: 'Duration' })).toHaveClass('text-right');
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 stages
  });

  test('shows a fallback and no chart region when there are no timeline-eligible stages', () => {
    renderTimeline(buildAppModel(new Map()));
    expect(screen.getByText(/no stages/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  test('clicking a stage bar opens that stage in the stage-detail dialog', async () => {
    const user = userEvent.setup();
    const appModel = buildAppModel(new Map([[1, makeStage(1, 100, 200)], [2, makeStage(2, 200, 300)]]));
    const getTaskData = vi.fn(async () => ({ metrics: [], fieldNames: [] }) as TaskData);
    const { container } = render(
      <StageDetailProvider>
        <Timeline appModel={appModel} catalog={[]} />
        <StageDetailDialog appModel={appModel} catalog={[]} getTaskData={getTaskData} />
      </StageDetailProvider>,
    );

    const bars = container.querySelectorAll('.recharts-bar-rectangle');
    // Two rectangles per stage (Wait + Duration, stacked): the second half
    // of the list is the visible "Duration" series this widget makes clickable.
    await user.click(bars[bars.length - 1]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /stage 2/i })).toBeInTheDocument();
  });

  test('labels the first real stage "Stage 0", matching the 0-indexed Spark stage ID StageTable uses', () => {
    const stages = new Map([[0, makeStage(0, 100, 200)], [1, makeStage(1, 200, 300)]]);
    const { container } = renderTimeline(buildAppModel(stages));

    // Recharts renders axis tick labels in a z-indexed layer that isn't
    // nested inside the `.recharts-yAxis` group, so the label group's own
    // axis-scoped class name (`recharts-yAxis-tick-labels`) is what
    // distinguishes it from the x-axis's labels.
    const yAxisLabels = container.querySelector('.recharts-yAxis-tick-labels');
    expect(yAxisLabels?.textContent).toContain('Stage 0');
  });

  test('thins y-axis labels instead of overlapping once stage count exceeds the legible row height', () => {
    const stages = new Map<number, unknown>();
    // Matches private-log-05's stage count (62) that
    // exposed the label collision at the fixed 320px chart height.
    const n = 62;
    // submittedAt/completedAt are absolute epoch ms in real data, so they're
    // never 0: offset by 100 to avoid tripping selectTimelineStages' falsy
    // timestamp filter for stage 0.
    for (let i = 0; i < n; i++) stages.set(i, makeStage(i, i * 100 + 100, i * 100 + 150));

    const { container } = renderTimeline(buildAppModel(stages));

    // Every row gets a tick group (kept for the tick line), but skipped
    // labels render blank text: only count the ones with visible text.
    const labelGroups = container.querySelectorAll(
      '.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-label',
    );
    const visibleLabels = Array.from(labelGroups).filter((el) => el.textContent);
    // 320px chart height / 16px minimum legible row height caps visible
    // labels at 20, fewer than the 62 stages, so shown labels stay spaced
    // out instead of colliding.
    expect(visibleLabels.length).toBeGreaterThan(1);
    expect(visibleLabels.length).toBeLessThanOrEqual(20);
    expect(visibleLabels.length).toBeLessThan(n);
    // The first tick is always kept (no starting-label skip), so the axis
    // still reads "Stage 0" at the top, not "Stage 1".
    expect(visibleLabels[0].textContent).toBe('Stage 0');
  });

  test('renders more x-axis gridlines than the recharts numeric-axis default', () => {
    const stages = new Map([[0, makeStage(0, 1000, 100000)], [1, makeStage(1, 100000, 250000)]]);
    const { container } = renderTimeline(buildAppModel(stages));

    const gridlines = container.querySelectorAll('.recharts-cartesian-grid-vertical line');
    // The widget raises Recharts' default numeric-axis tickCount (5) for denser gridlines.
    expect(gridlines.length).toBeGreaterThan(5);
  });

  test('advanced tier shows every stage, uncapped by the top-N default', () => {
    store.getState().setWidgetDensity('advanced');
    const stages = new Map<number, unknown>();
    const n = 3000;
    for (let i = 1; i <= n; i++) stages.set(i, makeStage(i, i * 10, i * 10 + 5));

    const { container } = renderTimeline(buildAppModel(stages));

    const rectCount = container.querySelectorAll('.recharts-bar-rectangle').length;
    expect(rectCount).toBeGreaterThan(0);
    // Two stacked series (Wait + Duration) per rendered row: still capped by the
    // downsample budget (2000, src/view/charts/downsample.ts), not by topN.
    expect(rectCount).toBeLessThan(n * 2);
    store.getState().setWidgetDensity('basic');
  });

  test('basic tier caps to the fixed top-N default regardless of stage count', () => {
    store.getState().setWidgetDensity('basic');
    const stages = new Map<number, unknown>();
    for (let i = 1; i <= 3000; i++) stages.set(i, makeStage(i, i * 10, i * 10 + 5));

    render(
      <StageDetailProvider>
        <Timeline appModel={buildAppModel(stages)} catalog={[]} />
      </StageDetailProvider>,
    );
    expect(screen.getByText(/of 3000 by duration/i)).toBeInTheDocument();
  });

  test('basic tier defaults the number input to the fixed top-N', () => {
    store.getState().setWidgetDensity('basic');
    const stages = new Map<number, unknown>();
    for (let i = 1; i <= 3000; i++) stages.set(i, makeStage(i, i * 10, i * 10 + 5));
    renderTimeline(buildAppModel(stages));

    expect(screen.getByRole('spinbutton', { name: /number of stages to show/i })).toHaveValue(20);
  });

  test('advanced tier defaults the number input to the total stage count', () => {
    store.getState().setWidgetDensity('advanced');
    const stages = new Map<number, unknown>();
    for (let i = 1; i <= 50; i++) stages.set(i, makeStage(i, i * 10, i * 10 + 5));
    renderTimeline(buildAppModel(stages));

    expect(screen.getByRole('spinbutton', { name: /number of stages to show/i })).toHaveValue(50);
    store.getState().setWidgetDensity('basic');
  });

  test('typing a manual N outside {20, total} is reachable in basic tier and renders that many rows', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('basic');
    const stages = new Map<number, unknown>();
    for (let i = 1; i <= 3000; i++) stages.set(i, makeStage(i, i * 10, i * 10 + 5));
    renderTimeline(buildAppModel(stages));

    // fireEvent.change sets the field to its final value directly, sidestepping
    // userEvent's keystroke-by-keystroke typing, which re-clamps against the
    // stale value after every character and can't land on an arbitrary N here.
    const input = screen.getByRole('spinbutton', { name: /number of stages to show/i });
    fireEvent.change(input, { target: { value: '5' } });

    expect(input).toHaveValue(5);
    expect(screen.getByText(/showing top/i)).toBeInTheDocument();
    expect(screen.getByText(/of 3000 by duration/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /table/i }));
    expect(screen.getAllByRole('row')).toHaveLength(6); // header + 5 stages
  });

  test('typing a manual N outside {20, total} is reachable in advanced tier and renders that many rows', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    const stages = new Map<number, unknown>();
    for (let i = 1; i <= 3000; i++) stages.set(i, makeStage(i, i * 10, i * 10 + 5));
    renderTimeline(buildAppModel(stages));

    const input = screen.getByRole('spinbutton', { name: /number of stages to show/i });
    fireEvent.change(input, { target: { value: '7' } });

    expect(input).toHaveValue(7);
    await user.click(screen.getByRole('button', { name: /table/i }));
    expect(screen.getAllByRole('row')).toHaveLength(8); // header + 7 stages
    store.getState().setWidgetDensity('basic');
  });

  test('the manual input is clamped to [1, total]', () => {
    store.getState().setWidgetDensity('basic');
    const stages = new Map([[1, makeStage(1, 100, 200)], [2, makeStage(2, 200, 300)]]);
    renderTimeline(buildAppModel(stages));

    const input = screen.getByRole('spinbutton', { name: /number of stages to show/i });
    fireEvent.change(input, { target: { value: '999' } });

    expect(input).toHaveValue(2);
  });

  test('shows a summary in the collapsed card header when stages exist', async () => {
    const user = userEvent.setup();
    const stages = new Map([[1, makeStage(1, 100, 200)], [2, makeStage(2, 200, 300)]]);
    const findings = [{ stageId: 1 } as Finding];
    renderTimeline(buildAppModel(stages), findings);

    // Collapse the card to show the summary
    await user.click(screen.getByRole('button', { name: /job timeline/i }));

    expect(screen.getByText(/2 stages/i)).toBeInTheDocument();
    expect(screen.getByText(/1 flagged/i)).toBeInTheDocument();
  });
});
