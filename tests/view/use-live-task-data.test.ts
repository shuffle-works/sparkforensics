// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { store } from '@/store/store';
import { useLiveTaskData } from '@/view/useLiveTaskData';

afterEach(() => {
  store.setState({ exportMode: false });
});

test('passes getTaskData through unchanged when not in export mode', () => {
  const getTaskData = vi.fn();
  const { result } = renderHook(() => useLiveTaskData(getTaskData));

  expect(result.current.exportMode).toBe(false);
  expect(result.current.getTaskData).toBe(getTaskData);
});

test('returns undefined for getTaskData in export mode, without calling it', () => {
  store.setState({ exportMode: true });
  const getTaskData = vi.fn();
  const { result } = renderHook(() => useLiveTaskData(getTaskData));

  expect(result.current.exportMode).toBe(true);
  expect(result.current.getTaskData).toBeUndefined();
  expect(getTaskData).not.toHaveBeenCalled();
});
