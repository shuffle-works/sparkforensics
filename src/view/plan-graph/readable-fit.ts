// Fit-to-view for the plan graph, with a floor on the zoom so node text stays
// legible. Kept as pure functions, separate from React Flow, so the arithmetic
// is unit-tested without rendering a canvas.

/** Smallest text a reader should have to squint at, in on-screen pixels. */
export const MIN_TEXT_PX = 11;
/** The smallest font a plan node or edge label sets (`text-[10px]`), in CSS px at zoom 1. */
export const SMALLEST_NODE_TEXT_PX = 10;
/** Lowest zoom a fit may land on: the smallest node text renders at MIN_TEXT_PX. */
export const MIN_READABLE_ZOOM = MIN_TEXT_PX / SMALLEST_NODE_TEXT_PX;
/** Highest zoom a fit may land on, so a one-node plan is not blown up grotesquely. */
export const MAX_FIT_ZOOM = 1.75;
/** Breathing room kept around the graph, in screen pixels. */
export const FIT_PADDING_PX = 24;

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The zoom at which `content` exactly fills `canvas` (minus padding), before any clamping. */
export function fitZoom(content: Size, canvas: Size, padding = FIT_PADDING_PX): number {
  const availableWidth = Math.max(canvas.width - padding * 2, 1);
  const availableHeight = Math.max(canvas.height - padding * 2, 1);
  return Math.min(availableWidth / Math.max(content.width, 1), availableHeight / Math.max(content.height, 1));
}

/**
 * The viewport a fit lands on. Zoom is the fit zoom clamped to
 * [MIN_READABLE_ZOOM, MAX_FIT_ZOOM]: a graph too large to fit at a readable zoom
 * overflows the canvas and scrolls instead of shrinking. On an axis that fits
 * the graph is centered; on an axis that overflows it is anchored to the
 * graph's start (left/top, where the reads and scans are) so the reader begins
 * at the beginning rather than in the middle of the plan.
 */
export function readableViewport(
  bounds: Rect,
  canvas: Size,
  opts: { padding?: number; minZoom?: number; maxZoom?: number } = {},
): Viewport {
  const { padding = FIT_PADDING_PX, minZoom = MIN_READABLE_ZOOM, maxZoom = MAX_FIT_ZOOM } = opts;
  const zoom = Math.min(maxZoom, Math.max(minZoom, fitZoom(bounds, canvas, padding)));
  const axis = (origin: number, extent: number, available: number) => {
    const scaled = extent * zoom;
    return scaled + padding * 2 > available
      ? padding - origin * zoom
      : (available - scaled) / 2 - origin * zoom;
  };
  return { zoom, x: axis(bounds.x, bounds.width, canvas.width), y: axis(bounds.y, bounds.height, canvas.height) };
}

/** True when every part of `bounds` is inside the visible canvas at `viewport`. */
export function viewportShowsAll(bounds: Rect, viewport: Viewport, canvas: Size): boolean {
  const left = bounds.x * viewport.zoom + viewport.x;
  const top = bounds.y * viewport.zoom + viewport.y;
  const right = left + bounds.width * viewport.zoom;
  const bottom = top + bounds.height * viewport.zoom;
  return left >= 0 && top >= 0 && right <= canvas.width && bottom <= canvas.height;
}

/** The widest content, in graph units, that fits `canvas` at MIN_READABLE_ZOOM. */
export function readableWidth(canvas: Size, padding = FIT_PADDING_PX): number {
  return Math.max(canvas.width - padding * 2, 1) / MIN_READABLE_ZOOM;
}

/** Share of `content` on screen at the zoom `readableViewport` lands on: 1 when
 * it all fits, less the more of it overflows and has to be scrolled to. */
export function visibleShare(content: Size, canvas: Size, padding = FIT_PADDING_PX): number {
  const zoom = Math.min(MAX_FIT_ZOOM, Math.max(MIN_READABLE_ZOOM, fitZoom(content, canvas, padding)));
  const share = (extent: number, available: number) =>
    Math.min(1, Math.max(available - padding * 2, 1) / Math.max(extent * zoom, 1));
  return share(content.width, canvas.width) * share(content.height, canvas.height);
}

/** Picks the candidate layout that shows the most of the plan at a readable zoom
 * (`visibleShare`), then the one that fits larger, so it fills the canvas. Ties
 * keep the earlier candidate. */
export function pickLayout<T extends { size: Size }>(candidates: [T, ...T[]], canvas: Size): T {
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const share = visibleShare(candidate.size, canvas);
    const bestShare = visibleShare(best.size, canvas);
    if (share > bestShare || (share === bestShare && fitZoom(candidate.size, canvas) > fitZoom(best.size, canvas))) {
      best = candidate;
    }
  }
  return best;
}
