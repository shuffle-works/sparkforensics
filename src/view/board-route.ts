import type { RouteOptions } from '@/store/board';
import { store } from '@/store/store';
import { resolveRoute, type BoardLayout, type RouteTarget } from '@/view/board-layout';

/** How a route to `target` lands: a finding is centred and flashed, a heading or region is scrolled
 * to its top, and an evidence row only takes focus. */
function landingOf(target: RouteTarget): RouteOptions {
  if ('finding' in target) return { flash: true, block: 'center' };
  return target.kind === 'landmark' ? { flash: false, block: 'start' } : { flash: false, block: 'nearest' };
}

/** Starts a route to `target` in `layout`. Returns whether the layout has a place for it. */
export function routeTo(layout: BoardLayout | null, target: RouteTarget): boolean {
  const resolved = layout ? resolveRoute(target, layout) : null;
  if (!resolved) return false;
  store.getState().startRoute(resolved, landingOf(target));
  return true;
}
