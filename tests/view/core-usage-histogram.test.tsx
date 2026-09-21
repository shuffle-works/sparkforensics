// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import { CoreUsageHistogram, gatherTaskIntervals } from '@/view/widgets/CoreUsageHistogram';
import { DocsProvider } from '@/view/DocsContext';
import type { AppModel, TaskData } from '@sparkforensics/core/types.ts';

const FIELD_NAMES = [
  'duration',
  'gcTime',
  'memorySpilled',
  'diskSpilled',
  'shuffleRead',
  'shuffleWrite',
  'launchTime',
  'finishTime',
];

// One task per array: stride 8, launchTime idx 6, finishTime idx 7; matches
// the worker's real per-stage layout.
function taskArray(launch: number, finish: number): Float64Array {
  const a = new Float64Array(8);
  a[6] = launch;
  a[7] = finish;
  return a;
}

function buildAppModel(stageIds: number[]): AppModel {
  return { ...emptyAppModel(), stages: new Map(stageIds.map((id) => [id, { id }])) };
}

test('gatherTaskIntervals extracts launch/finish across all stages', async () => {
  const appModel = buildAppModel([1, 2]);
  const getTaskData = async (id: number): Promise<TaskData> => ({
    metrics: taskArray(id * 100, id * 100 + 500),
    fieldNames: FIELD_NAMES,
  });
  const { intervals, incomplete } = await gatherTaskIntervals(appModel, getTaskData);
  expect(incomplete).toBe(false);
  expect(intervals).toEqual([
    { launch: 100, finish: 600 },
    { launch: 200, finish: 700 },
  ]);
});

test('gatherTaskIntervals flags incomplete when a stage returns null', async () => {
  const appModel = buildAppModel([1, 2]);
  const getTaskData = async (id: number): Promise<TaskData> => {
    if (id === 2) throw new Error('released');
    return { metrics: taskArray(100, 600), fieldNames: FIELD_NAMES };
  };
  const { intervals, incomplete } = await gatherTaskIntervals(appModel, getTaskData);
  expect(incomplete).toBe(true);
  expect(intervals).toEqual([{ launch: 100, finish: 600 }]);
});

test('renders the WidgetCard heading and a chart region once task data resolves', async () => {
  const user = userEvent.setup();
  const appModel = buildAppModel([1]);
  const getTaskData = async (): Promise<TaskData> => ({
    metrics: taskArray(0, 1000),
    fieldNames: FIELD_NAMES,
  });

  render(
    <DocsProvider>
      <CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} />
    </DocsProvider>,
  );

  expect(screen.getByText('Core-Usage Distribution')).toBeInTheDocument();
  // Card is collapsed by default; expand it to reach the chart region.
  await user.click(screen.getByRole('button', { name: /core-usage distribution/i }));
  await waitFor(() => {
    expect(screen.getByRole('img', { name: /concurrent-core count/i })).toBeInTheDocument();
  });
});

test('renders a doc link pointing at the bottleneck-utilization anchor', async () => {
  const user = userEvent.setup();
  const appModel = buildAppModel([1]);
  const getTaskData = async (): Promise<TaskData> => ({
    metrics: taskArray(0, 1000),
    fieldNames: FIELD_NAMES,
  });

  render(
    <DocsProvider>
      <CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} />
    </DocsProvider>,
  );

  await user.click(screen.getByRole('button', { name: /core-usage distribution/i }));
  const link = await screen.findByRole('link', { name: /how to read concurrent-core utilization/i });
  expect(link.getAttribute('href')).toContain('#bottleneck-utilization');
});

test('renders nothing when there are no stages', () => {
  const appModel = buildAppModel([]);
  const getTaskData = async (): Promise<TaskData> => ({ metrics: [], fieldNames: FIELD_NAMES });
  const { container } = render(<CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} />);
  expect(container.firstChild).toBeNull();
});

test('downsamples a large histogram before handing it to the chart', { timeout: 15000 }, async () => {
  // 5000 tasks over [0,1) produce a 5000-bucket histogram, well past the 2000-point budget.
  const user = userEvent.setup();
  const appModel = buildAppModel([1]);
  const taskCount = 5000;
  const metrics = new Float64Array(taskCount * FIELD_NAMES.length);
  for (let i = 0; i < taskCount; i++) {
    const base = i * FIELD_NAMES.length;
    metrics[base + 6] = 0; // launchTime
    metrics[base + 7] = 1; // finishTime
  }
  const getTaskData = async (): Promise<TaskData> => ({ metrics, fieldNames: FIELD_NAMES });

  const { container } = render(
    <DocsProvider>
      <CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} />
    </DocsProvider>,
  );

  // Card is collapsed by default; expand it so the chart mounts.
  await user.click(screen.getByRole('button', { name: /core-usage distribution/i }));
  await waitFor(() => {
    expect(container.querySelectorAll('.recharts-bar-rectangle').length).toBeGreaterThan(0);
  });
  const bars = container.querySelectorAll('.recharts-bar-rectangle');
  expect(bars.length).toBeLessThanOrEqual(2000);
});

test('exposes a data table matching the full-resolution histogram, hidden by default', async () => {
  const user = userEvent.setup();
  const appModel = buildAppModel([1]);
  const getTaskData = async (): Promise<TaskData> => ({
    metrics: taskArray(0, 1000),
    fieldNames: FIELD_NAMES,
  });

  render(
    <DocsProvider>
      <CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} />
    </DocsProvider>,
  );

  await user.click(screen.getByRole('button', { name: /core-usage distribution/i }));
  await waitFor(() => screen.getByRole('button', { name: /table/i }));
  await user.click(screen.getByRole('button', { name: /table/i }));

  expect(screen.getByRole('columnheader', { name: 'Concurrent cores' })).toHaveClass('text-right');
  expect(screen.getByRole('columnheader', { name: 'Time' })).toHaveClass('text-right');
});

// Regression: the fetch is gated on the WidgetCard's open state (not mount)
// and cached, so a collapsed widget fetches nothing.
test('does not fetch task data while collapsed, fetches once expanded, and does not refetch on re-collapse', async () => {
  const user = userEvent.setup();
  const appModel = buildAppModel([1]);
  const getTaskData = vi.fn(async (): Promise<TaskData> => ({
    metrics: taskArray(0, 1000),
    fieldNames: FIELD_NAMES,
  }));

  render(
    <DocsProvider>
      <CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} />
    </DocsProvider>,
  );

  expect(getTaskData).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: /core-usage distribution/i }));
  await waitFor(() => expect(getTaskData).toHaveBeenCalledTimes(1));

  // Collapse then re-expand: cached, no refetch.
  await user.click(screen.getByRole('button', { name: /core-usage distribution/i }));
  await user.click(screen.getByRole('button', { name: /core-usage distribution/i }));
  expect(getTaskData).toHaveBeenCalledTimes(1);
});

test('shows an honest export-mode message instead of fetching task data', async () => {
  const user = userEvent.setup();
  const appModel = buildAppModel([1]);
  const getTaskData = vi.fn(async (): Promise<TaskData> => ({
    metrics: taskArray(0, 1000),
    fieldNames: FIELD_NAMES,
  }));
  store.setState({ exportMode: true });

  render(
    <DocsProvider>
      <CoreUsageHistogram appModel={appModel} getTaskData={getTaskData} />
    </DocsProvider>,
  );
  await user.click(screen.getByRole('button', { name: /core-usage distribution/i }));

  expect(await screen.findByText(/isn.t included in exported reports/i)).toBeInTheDocument();
  expect(getTaskData).not.toHaveBeenCalled();
  store.setState({ exportMode: false });
});
