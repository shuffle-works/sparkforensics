// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PinnedStageDeltas } from '@/view/PinnedStageDeltas';

const M = (over: any) => ({
  duration: 1000, memoryBytesSpilled: 0, diskBytesSpilled: 0, jvmGCTime: 100,
  inputBytes: 0, outputBytes: 0, executorRunTime: 5000, taskCount: 10, failedTasks: 0, ...over,
});

test('pins a base/candidate stage pair and shows signed per-field deltas', async () => {
  const user = userEvent.setup();
  const baseStages = [{ id: 1, name: 'Exchange 1', metrics: M({ memoryBytesSpilled: 2_000_000, executorRunTime: 5000 }) }];
  const candStages = [{ id: 9, name: 'Exchange 2', metrics: M({ memoryBytesSpilled: 1_000_000, executorRunTime: 4000 }) }];
  render(<PinnedStageDeltas baseStages={baseStages} candStages={candStages} />);

  await user.selectOptions(screen.getByLabelText(/baseline stage/i), '1');
  await user.selectOptions(screen.getByLabelText(/candidate stage/i), '9');
  await user.click(screen.getByRole('button', { name: /pin pair/i }));

  // "Exchange 1"/"Exchange 2" alone also match the <option> elements in the
  // selects above, so assert on the pinned pair's own header text instead.
  expect(screen.getByText('Exchange 1 → Exchange 2')).toBeInTheDocument();
  expect(screen.getByText('-1 MB')).toBeInTheDocument();   // memory spill delta (cand − base)
  expect(screen.getByText('-1.0s')).toBeInTheDocument();   // executor run-time delta: 4000-5000=-1000ms → formatDuration(1000) = '1.0s'

  await user.click(screen.getByRole('button', { name: /remove/i }));
  expect(screen.queryByText('-1 MB')).not.toBeInTheDocument();
});

test('renders nothing actionable when a run has no stages', () => {
  render(<PinnedStageDeltas baseStages={[]} candStages={[]} />);
  expect(screen.queryByRole('button', { name: /pin pair/i })).not.toBeInTheDocument();
});
