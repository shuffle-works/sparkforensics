import { useCallback, useState } from 'react';

import type { ActiveRoute, BoardState } from '@/store/board';
import { store, useStore } from '@/store/store';

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** The active route while it has not landed yet. */
function pendingRoute(board: BoardState): ActiveRoute | null {
  return board.route != null && board.route.token > board.landedToken ? board.route : null;
}

/** The token of the active route when it lands on one of `keys`, else 0. */
function useRouteToken(keys: readonly string[]): number {
  return useStore((s) => {
    const { route } = s.board;
    return route?.rowKey != null && keys.includes(route.rowKey) ? route.token : 0;
  });
}

/** Ref callback for the element that takes the route's focus when the route's `rowKey` is one of
 * `keys`. The element lands itself, in the commit that mounts it, so a route to a row in a card
 * the route opens needs no wait for the card. Each route lands once: an element that mounts again
 * under the same route does not take focus again. */
export function useLanding(keys: readonly string[]): (element: HTMLElement | null) => void {
  const token = useRouteToken(keys);
  return useCallback((element: HTMLElement | null) => {
    if (!element || token === 0) return;
    const { board, landRoute } = store.getState();
    if (board.landedToken >= token) return;
    landRoute(token);
    element.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: board.route?.block ?? 'nearest', inline: 'nearest' });
    element.focus({ preventScroll: true });
  }, [token]);
}

/** Whether the active route flashes a row with one of `keys`. The flash is a CSS animation that
 * ends by itself; the next route ends the mark. Only a row mounted while the route is pending
 * flashes, so a row that mounts again after the route landed does not flash again. */
export function useRouteFlash(keys: readonly string[]): boolean {
  const token = useStore((s) => {
    const { route } = s.board;
    return route?.flash === true && route.rowKey != null && keys.includes(route.rowKey) ? route.token : 0;
  });
  const pending = useStore((s) => token !== 0 && pendingRoute(s.board)?.token === token);
  const [flashedToken, setFlashedToken] = useState(0);
  if (pending && flashedToken !== token) setFlashedToken(token);
  return token !== 0 && (pending || flashedToken === token);
}

/** The key of the pending route's row, for a list that shows the page holding it. Once the route
 * lands the list keeps the page it moved to and pages freely. */
export function useRouteRowKey(): string | null {
  return useStore((s) => pendingRoute(s.board)?.rowKey ?? null);
}

/** A line the triage shortcuts step through: lands on a route to `lineKey` and tells the board it
 * holds focus, so j/k step from it. */
export function useLine(lineKey: string) {
  const ref = useLanding([lineKey]);
  return {
    ref,
    onFocus: () => store.getState().setCursor(lineKey),
    onBlur: () => store.getState().setCursor(null),
  } as const;
}
