// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { store } from '@/store/store';
import { useLiveTaskData } from '@/view/useLiveTaskData';
import { runState } from './_shared/run';

afterEach(() => {
  store.getState().resetModel();
});

test('passes getTaskData through unchanged when the run has a task data source', () => {
  store.setState(runState());
  const getTaskData = vi.fn();
  const { result } = renderHook(() => useLiveTaskData(getTaskData));

  expect(result.current.unavailable).toBe(false);
  expect(result.current.getTaskData).toBe(getTaskData);
});

test('returns undefined for getTaskData when the run has no task data, without calling it', () => {
  store.setState(runState({ taskData: { kind: 'none' } }));
  const getTaskData = vi.fn();
  const { result } = renderHook(() => useLiveTaskData(getTaskData));

  expect(result.current.unavailable).toBe(true);
  expect(result.current.getTaskData).toBeUndefined();
  expect(getTaskData).not.toHaveBeenCalled();
});
