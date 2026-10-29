// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StageTaskSpread } from '@/view/StageTaskSpread';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel, TaskData } from '@sparkforensics/core/types.ts';
import { runState } from './_shared/run';

function appModelWithStage(): AppModel {
  const appModel = emptyAppModel();
  appModel.stages.set(3, { id: 3, taskDurationP50: 100, taskDurationP95: 300, taskDurationMax: 400 } as never);
  return appModel;
}

const getTaskData = vi.fn(() => Promise.reject<TaskData>(new Error('no task data')));
const toggle = () => screen.queryByRole('button', { name: /task detail/i });

function renderSpread(children?: React.ReactNode) {
  return render(
    <StageTaskSpread stageId={3} appModel={appModelWithStage()} getTaskData={getTaskData} idPrefix="test">
      {children}
    </StageTaskSpread>,
  );
}

beforeEach(() => {
  store.getState().resetModel();
  getTaskData.mockClear();
});

test('the live dashboard offers Task detail, which fetches the stage tasks', async () => {
  renderSpread();

  await userEvent.click(toggle()!);

  expect(getTaskData).toHaveBeenCalledWith(3);
});

test('a run with no task data offers no Task detail that would open to nothing', () => {
  store.setState(runState({ taskData: { kind: 'none' } }));

  renderSpread();

  expect(toggle()).toBeNull();
  expect(screen.getByText(/P95/)).toBeInTheDocument();
});

test('a run with no task data keeps the disclosure when it holds something else, such as the stage plan', async () => {
  store.setState(runState({ taskData: { kind: 'none' } }));

  renderSpread(<p>Stage plan</p>);
  await userEvent.click(toggle()!);

  expect(screen.getByText('Stage plan')).toBeInTheDocument();
  expect(screen.getByText(/isn.t available for this run/i)).toBeInTheDocument();
  expect(getTaskData).not.toHaveBeenCalled();
});
