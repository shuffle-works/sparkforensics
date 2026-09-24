// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TaskFailures } from '../../src/view/widgets/TaskFailures';
import { StageDetailProvider } from '../../src/view/StageDetailContext';
import { emptyAppModel, store } from '../../src/store/store';
import { expectImpactThenStageOrderByAccessibleName } from './_shared/sort-order-toggle';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

function makeAppModel(stageNames: Record<number, string>): AppModel {
  const stages = new Map(Object.entries(stageNames).map(([id, name]) => [Number(id), { id: Number(id), name }]));
  return { ...emptyAppModel(), stages };
}

const DEFAULT_STAGES = { 1: 'scan', 2: 'join', 3: 'aggregate', 4: 'shuffle' };

function render_(catalog: Finding[], appModel: AppModel = makeAppModel(DEFAULT_STAGES)) {
  return render(
    <StageDetailProvider>
      <TaskFailures appModel={appModel} catalog={catalog} />
    </StageDetailProvider>,
  );
}

describe('TaskFailures', () => {
  it('renders nothing when there are no failed tasks', () => {
    const { container } = render_([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing regardless of appModel stage data, when the catalog has no failures findings', () => {
    const stages = new Map([
      [1, { id: 1, name: 'scan', taskCount: 100, failedTasks: 5 }],
      [2, { id: 2, name: 'join', taskCount: 50, failedTasks: 0 }],
    ]);
    const appModel: AppModel = { ...emptyAppModel(), stages } as AppModel;
    const { container } = render_([], appModel);
    expect(container).toBeEmptyDOMElement();
  });

  it('flags every affected stage, not just the worst', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [
      { type: 'failures', stageId: 1, impactBand: 'warning', metric: 'failureRate', value: 12, failedTasks: 5, dominantReason: 'FetchFailed', recommendation: 'Investigate driver logs.' },
      { type: 'failures', stageId: 2, impactBand: 'critical', metric: 'failureRate', value: 40, failedTasks: 20, dominantReason: null, recommendation: 'Investigate driver logs.' },
    ];
    render_(catalog);
    await user.click(screen.getByRole('button', { name: /^failed tasks$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 2/i })).toBeInTheDocument();
    expect(screen.getByText('FetchFailed')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the FAIL tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
    const catalog: Finding[] = [
      { type: 'failures', stageId: 1, impactBand: 'warning', metric: 'failureRate', value: 12, failedTasks: 5, dominantReason: 'FetchFailed', recommendation: 'Investigate driver logs.' },
      { type: 'failures', stageId: 2, impactBand: 'critical', metric: 'failureRate', value: 40, failedTasks: 20, dominantReason: null, recommendation: 'Investigate driver logs.' },
    ];
    const { container } = render_(catalog);
    expect(screen.getByText('FAIL')).toBeInTheDocument();
    // One dot inside the header TagBadge itself, plus one per flagged stage row.
    expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
  });

  it('shows a row\'s recommendation by default, with no per-row toggle', () => {
    const catalog: Finding[] = [
      { type: 'failures', stageId: 1, impactBand: 'warning', metric: 'failureRate', value: 12, failedTasks: 5, dominantReason: 'FetchFailed', recommendation: 'Investigate driver logs for stage 1.' },
    ];
    render_(catalog);
    expect(screen.getByText('Investigate driver logs for stage 1.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confidence|evidence|task detail/i })).not.toBeInTheDocument();
  });

  it('names the dominant error and shows one stack excerpt per distinct failure', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [{
      type: 'failures', stageId: 1, impactBand: 'critical', metric: 'failureRate', value: 30, failedTasks: 9,
      dominantReason: 'ExceptionFailure', dominantError: 'java.lang.IllegalStateException', otherFailedTasks: 2,
      failureGroups: [
        { reason: 'ExceptionFailure', className: 'java.lang.IllegalStateException', message: 'bad row', lossReason: null, count: 5,
          stackExcerpt: 'java.lang.IllegalStateException: bad row\n\tat com.example.Job.run(Job.scala:10)' },
        { reason: 'ExecutorLostFailure', className: null, message: null, lossReason: 'Container killed by YARN for exceeding memory limits.', stackExcerpt: null, count: 2 },
      ],
    }];
    const { container } = render_(catalog);
    await user.click(screen.getByRole('button', { name: 'Failed Tasks' }));
    expect(screen.getByText('java.lang.IllegalStateException')).toBeInTheDocument();
    const groups = within(screen.getByRole('list', { name: 'Distinct failures' })).getAllByRole('listitem');
    expect(groups.map((g) => g.textContent)).toEqual([
      expect.stringContaining('5 tasks: java.lang.IllegalStateException: bad row'),
      expect.stringContaining('2 tasks: ExecutorLostFailure: Container killed by YARN for exceeding memory limits.'),
      '2 more failed tasks not shown',
    ]);
    const excerpts = container.querySelectorAll('pre');
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].textContent).toBe('java.lang.IllegalStateException: bad row\n\tat com.example.Job.run(Job.scala:10)');
  });

  it('paginates the stage list 6-at-a-time, resetting to page 1 on a fresh appModel', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'failures' as const, stageId: i + 1, impactBand: 'warning' as const, metric: 'failureRate', value: 10 + i, failedTasks: 2, dominantReason: null,
    }));
    const stageNames = Object.fromEntries(catalog.map((f) => [f.stageId as number, `stage-${f.stageId}`]));
    const { rerender } = render_(catalog, makeAppModel(stageNames));

    // Card defaults collapsed; open it first to access the content.
    await user.click(screen.getByRole('button', { name: 'Failed Tasks' }));

    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();

    rerender(
      <StageDetailProvider>
        <TaskFailures appModel={makeAppModel(stageNames)} catalog={catalog} />
      </StageDetailProvider>,
    );
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('defaults to impact order (highest potential savings first), and a toggle flips it back to stage order at advanced density', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    const catalog: Finding[] = [
      { type: 'failures', stageId: 1, impactBand: 'warning', metric: 'failureRate', value: 40, impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } },
      { type: 'failures', stageId: 2, impactBand: 'warning', metric: 'failureRate', value: 10, impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } },
    ];
    render_(catalog);

    // Card defaults collapsed; open it first to access the content.
    await user.click(screen.getByRole('button', { name: 'Failed Tasks' }));

    const rows = () => screen.getAllByRole('button', { name: /open details for stage \d/i });
    await expectImpactThenStageOrderByAccessibleName(user, rows, /stage 1/i, /stage 2/i);
    store.getState().setWidgetDensity('basic');
  });

  it('hides the sort toggle at basic density', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [
      { type: 'failures', stageId: 1, impactBand: 'warning', metric: 'failureRate', value: 40, impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } },
      { type: 'failures', stageId: 2, impactBand: 'warning', metric: 'failureRate', value: 10, impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } },
    ];
    render_(catalog);

    await user.click(screen.getByRole('button', { name: 'Failed Tasks' }));

    expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
  });
});
