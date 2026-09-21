// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExpandableRow } from '@/view/useExpandableRow';

test('starts collapsed', () => {
  const { result } = renderHook(() => useExpandableRow());
  expect(result.current.expanded).toBe(false);
});

test('toggle flips expanded; with no fetchFn, data/loading/error stay inert', () => {
  const { result } = renderHook(() => useExpandableRow());

  act(() => result.current.toggle());
  expect(result.current.expanded).toBe(true);
  expect(result.current.data).toBeNull();
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBe(false);

  act(() => result.current.toggle());
  expect(result.current.expanded).toBe(false);
});

test('expanding with a fetchFn lazily fetches and populates data', async () => {
  const fetchFn = vi.fn(async () => 'result');
  const { result } = renderHook(() => useExpandableRow(fetchFn));

  expect(fetchFn).not.toHaveBeenCalled();
  act(() => result.current.toggle());

  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(result.current.loading).toBe(true);

  await act(async () => {});
  expect(result.current.loading).toBe(false);
  expect(result.current.data).toBe('result');
});

test('does not re-fetch once data is already loaded', async () => {
  const fetchFn = vi.fn(async () => 'result');
  const { result } = renderHook(() => useExpandableRow(fetchFn));

  act(() => result.current.toggle()); // expand, triggers fetch
  await act(async () => {});
  act(() => result.current.toggle()); // collapse
  act(() => result.current.toggle()); // re-expand

  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test('a rejected fetchFn sets error instead of hanging in loading', async () => {
  const fetchFn = vi.fn(async () => {
    throw new Error('fail');
  });
  const { result } = renderHook(() => useExpandableRow(fetchFn));

  act(() => result.current.toggle());
  await act(async () => {});

  expect(result.current.error).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(result.current.data).toBeNull();
});
