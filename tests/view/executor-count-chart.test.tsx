// @vitest-environment jsdom
import { useState } from 'react';
import { test, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel } from '@/store/store';
import type { AppModel } from '@sparkforensics/core/types.ts';

// Wrap-not-replace: tests still run the real downsample; the memoization test reads its call count.
vi.mock('@/view/charts/downsample', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/view/charts/downsample')>();
  return { downsample: vi.fn(actual.downsample) };
});

const { ExecutorCountChart } = await import('@/view/widgets/ExecutorCountChart');
const { downsample } = await import('@/view/charts/downsample');

function buildAppModel(): AppModel {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 100_000 } as AppModel['app'],
    executors: {
      added: [
        { executorId: '1', timestamp: 0 },
        { executorId: '2', timestamp: 20_000 },
      ] as unknown as AppModel['executors']['added'],
      removed: [
        { executorId: '1', timestamp: 80_000 },
      ] as unknown as AppModel['executors']['removed'],
    },
  };
}

test('renders the WidgetCard heading and a chart region', () => {
  render(<ExecutorCountChart appModel={buildAppModel()} />);
  expect(screen.getByRole('heading', { name: 'Executor Count Over Time' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /executor count over time/i })).toBeInTheDocument();
});

test('reflects the ported computeExecutorSeries math in the data table', async () => {
  const user = userEvent.setup();
  render(<ExecutorCountChart appModel={buildAppModel()} />);

  await user.click(screen.getByRole('button', { name: /table/i }));

  // Two executors overlap between t=20s and t=80s -> peak concurrent = 2.
  const rows = screen.getAllByRole('row').slice(1);
  expect(rows.some((r) => r.textContent?.includes('2'))).toBe(true);
});

test('exposes a full-series data table with a right-aligned count column', async () => {
  const user = userEvent.setup();
  render(<ExecutorCountChart appModel={buildAppModel()} />);

  await user.click(screen.getByRole('button', { name: /table/i }));

  expect(screen.getByRole('columnheader', { name: 'Time' })).toBeInTheDocument();
  const countHeader = screen.getByRole('columnheader', { name: 'Active executors' });
  expect(countHeader).toHaveClass('text-right');
  expect(screen.getAllByRole('row').length).toBeGreaterThan(2);
});

test('shows a peak-concurrency summary when the run has series data', async () => {
  const user = userEvent.setup();
  render(<ExecutorCountChart appModel={buildAppModel()} />);

  // WidgetCard only renders `summary` while collapsed (mirrors Timeline's
  // and EtlPhases' own summary tests): collapse the card to reveal it.
  await user.click(screen.getByRole('button', { name: /executor count over time/i }));

  expect(screen.getByText(/2 peak/)).toBeInTheDocument();
});

test('shows no peak-concurrency summary when the run has no time base to build a series from', async () => {
  const user = userEvent.setup();
  const noSeriesAppModel = {
    ...buildAppModel(),
    app: { startTime: null, endTime: null } as unknown as AppModel['app'],
  } as AppModel;
  render(<ExecutorCountChart appModel={noSeriesAppModel} />);

  // WidgetCard only renders `summary` while collapsed: collapse the card
  // first, same as the positive test above, so this actually discriminates
  // on `hasSeries` instead of the summary being hidden regardless.
  await user.click(screen.getByRole('button', { name: /executor count over time/i }));

  expect(screen.queryByText(/peak/)).not.toBeInTheDocument();
});

// Regression: a run with no ApplicationEnd event (startTime present, endTime
// null) must self-hide the chart instead of substituting Date.now() for the
// missing end time, which used to plot a fabricated multi-week axis.
test('self-hides with an unavailable message when the run has no end time recorded', () => {
  const incompleteRunAppModel = {
    ...buildAppModel(),
    app: { startTime: 0, endTime: null } as unknown as AppModel['app'],
  } as AppModel;
  render(<ExecutorCountChart appModel={incompleteRunAppModel} />);

  expect(screen.getByText(/no ApplicationEnd event/i)).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: /executor count over time/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /table/i })).not.toBeInTheDocument();
});

// Guards the useMemo (keyed on appModel + activeFileId) that skips recomputing
// the executor series and downsample pipeline on an unrelated re-render.
test('does not recompute the executor series when an unrelated re-render occurs with the same props', async () => {
  const user = userEvent.setup();
  const appModel = buildAppModel();
  const callsBefore = (downsample as Mock).mock.calls.length;

  function Harness() {
    const [, setTick] = useState(0);
    return (
      <div>
        <button onClick={() => setTick((t) => t + 1)}>tick</button>
        <ExecutorCountChart appModel={appModel} />
      </div>
    );
  }

  render(<Harness />);
  expect((downsample as Mock).mock.calls.length - callsBefore).toBe(1);

  await user.click(screen.getByRole('button', { name: 'tick' }));
  expect((downsample as Mock).mock.calls.length - callsBefore).toBe(1);
});

// Regression: applySnapshot mutates appModel's fields in place (same object
// reference), so an activeFileId change must still swap the chart to the new file.
test('reflects a new file after appModel is mutated in place and activeFileId changes (cached-file switch)', async () => {
  const appModel = buildAppModel();

  const peakOfLastSeries = () =>
    Math.max(...((downsample as Mock).mock.lastCall![0] as { count: number }[]).map((p) => p.count));

  const { rerender } = render(<ExecutorCountChart appModel={appModel} activeFileId="file-a" />);
  expect(peakOfLastSeries()).toBe(2);

  appModel.executors = {
    added: [
      { executorId: '1', timestamp: 0 },
      { executorId: '2', timestamp: 10_000 },
      { executorId: '3', timestamp: 20_000 },
    ] as unknown as AppModel['executors']['added'],
    removed: [
      { executorId: '1', timestamp: 90_000 },
    ] as unknown as AppModel['executors']['removed'],
  };

  rerender(<ExecutorCountChart appModel={appModel} activeFileId="file-b" />);

  expect(peakOfLastSeries()).toBe(3);
});
