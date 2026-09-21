// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { usePagedRows } from '@/view/usePagedRows';

// usePagedRows leaves `page` state owned by the caller; this harness plays
// that role so one `renderHook` exercises both the derived values and the real
// `page` state the hook's useLayoutEffect persists a route jump into.
function useHarness<T>(items: T[], routeIndex: number | null = null) {
  const [page, setPage] = useState(0);
  const paged = usePagedRows(items, page, setPage, routeIndex);
  return { ...paged, page, setPage };
}

function items(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

test('paginates 6-at-a-time: a full first page, the right page count, and Next revealing the partial last page', () => {
  const { result } = renderHook(() => useHarness(items(8)));
  expect(result.current.totalPages).toBe(2);
  expect(result.current.effectivePage).toBe(0);
  expect(result.current.visible).toEqual([0, 1, 2, 3, 4, 5]);

  act(() => result.current.setPage(1));
  expect(result.current.effectivePage).toBe(1);
  expect(result.current.visible).toEqual([6, 7]);
});

test('an exact multiple of the page size has no trailing empty page', () => {
  const { result } = renderHook(() => useHarness(items(12)));
  expect(result.current.totalPages).toBe(2);
});

test('an empty item list has zero pages and an empty visible slice, without going negative', () => {
  const { result } = renderHook(() => useHarness(items(0)));
  expect(result.current.totalPages).toBe(0);
  expect(result.current.effectivePage).toBe(0);
  expect(result.current.visible).toEqual([]);
});

test('clamps effectivePage down to the last valid page when the item count shrinks past the active page, with no route jump active (regression guard for 579e9f0)', () => {
  const { result, rerender } = renderHook(({ list }: { list: number[] }) => useHarness(list), {
    initialProps: { list: items(8) }, // 2 pages
  });

  act(() => result.current.setPage(1)); // move to the second (last) page
  expect(result.current.effectivePage).toBe(1);

  // When the catalog shrinks live while the widget stays mounted at page 1,
  // `effectivePage` must clamp down to a valid page instead of stranding the
  // widget on an empty slice with a stuck-enabled Next button.
  rerender({ list: items(3) }); // 1 page
  expect(result.current.totalPages).toBe(1);
  expect(result.current.effectivePage).toBe(0);
  expect(result.current.visible).toEqual([0, 1, 2]);
});

test('clamps to zero (never negative) when the item list empties out entirely while on a later page', () => {
  const { result, rerender } = renderHook(({ list }: { list: number[] }) => useHarness(list), {
    initialProps: { list: items(8) },
  });

  act(() => result.current.setPage(1));
  rerender({ list: items(0) });
  expect(result.current.totalPages).toBe(0);
  expect(result.current.effectivePage).toBe(0);
  expect(result.current.visible).toEqual([]);
});

test('an active routeIndex jumps to and persists the page containing that index, overriding what the clamp would otherwise select', () => {
  const { result, rerender } = renderHook(
    ({ list, routeIndex }: { list: number[]; routeIndex: number | null }) => useHarness(list, routeIndex),
    { initialProps: { list: items(8), routeIndex: null as number | null } },
  );

  expect(result.current.page).toBe(0);

  // Route to the last item (index 7): its own page (1) differs from the
  // clamped current page (0), so this only passes if the jump actually wins
  // over the clamp rather than the clamp overriding it.
  rerender({ list: items(8), routeIndex: 7 });
  expect(result.current.effectivePage).toBe(1);
  expect(result.current.visible).toEqual([6, 7]);
  // The jump also persists into real `page` state (the hook's own
  // useLayoutEffect), so it survives once the route target clears.
  expect(result.current.page).toBe(1);

  rerender({ list: items(8), routeIndex: null });
  expect(result.current.effectivePage).toBe(1);
  expect(result.current.page).toBe(1);
});

test('routeIndex === -1 is treated as no active route: falls back to the clamped page instead of an invalid negative one', () => {
  const { result, rerender } = renderHook(
    ({ list, routeIndex }: { list: number[]; routeIndex: number | null }) => useHarness(list, routeIndex),
    { initialProps: { list: items(8), routeIndex: null as number | null } },
  );

  act(() => result.current.setPage(1));
  rerender({ list: items(8), routeIndex: -1 });
  // clamped(page=1) for 2 total pages stays 1; -1 must not be floored into
  // Math.floor(-1 / 6) === -1, an out-of-range page.
  expect(result.current.effectivePage).toBe(1);
  expect(result.current.page).toBe(1);
});
