import { useLayoutEffect, type Dispatch, type SetStateAction } from 'react';

import { VISIBLE_LIMIT } from '@sparkforensics/core/format-utils.ts';

export interface UsePagedRowsResult<T> {
  totalPages: number;
  effectivePage: number;
  visible: T[];
}

/**
 * Shared VISIBLE_LIMIT-at-a-time pagination math. Page state itself stays
 * owned by the caller (see the file header comment): this hook only computes
 * `totalPages`/`visible` and, when `routeIndex` is given, jumps to the page
 * containing it.
 *
 * The jump happens twice: synchronously during render (`effectivePage`), so
 * a route landing in the same commit a widget first mounts still reveals its
 * target row in that commit, and via the `useLayoutEffect` below, which
 * persists the jump into real `page` state so it survives the route
 * clearing and subsequent prev/next navigation starts from the revealed
 * page.
 */
export function usePagedRows<T>(
  items: T[],
  page: number,
  setPage: Dispatch<SetStateAction<number>>,
  routeIndex: number | null = null,
): UsePagedRowsResult<T> {
  const totalPages = Math.ceil(items.length / VISIBLE_LIMIT);
  // Clamp to the current totalPages when there's no active route jump, so a
  // catalog that shrinks live (filter bar, cached-file switch) while the
  // widget stays mounted at a now out-of-range page doesn't strand the user
  // on an empty page with a stuck-enabled Next button.
  const clamped = Math.min(page, Math.max(0, totalPages - 1));
  const effectivePage = routeIndex == null || routeIndex === -1 ? clamped : Math.floor(routeIndex / VISIBLE_LIMIT);
  const visible = items.slice(effectivePage * VISIBLE_LIMIT, (effectivePage + 1) * VISIBLE_LIMIT);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `items` is a fresh reference every render; see the comment above.
  useLayoutEffect(() => {
    if (routeIndex == null || routeIndex === -1) return;
    const targetPage = Math.floor(routeIndex / VISIBLE_LIMIT);
    setPage((current) => (current === targetPage ? current : targetPage));
  }, [routeIndex]);

  return { totalPages, effectivePage, visible };
}
