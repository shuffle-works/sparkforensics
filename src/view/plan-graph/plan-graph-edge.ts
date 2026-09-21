// Visual scaling for weighted exchange edges. Kept as pure functions, separate
// from the React edge component, so the byte -> stroke mapping is unit-tested
// without rendering React Flow. The magnitude is a NEUTRAL dimension (bytes
// moved is not a defect), so per DESIGN.md's Magnitude-Encoding Clause it maps
// to stroke width and a single-hue intensity, never a status color.

export const EXCHANGE_EDGE_MIN_WIDTH = 1.5;
export const EXCHANGE_EDGE_MAX_WIDTH = 9;
export const EXCHANGE_EDGE_MIN_OPACITY = 0.55;
export const EXCHANGE_EDGE_MAX_OPACITY = 1;

/** Fraction in [0, 1] of `bytes` against the heaviest edge, on a log scale so a
 * single huge exchange doesn't flatten every other weighted edge to the floor.
 * Returns 0 for a non-positive or missing max. */
function magnitudeRatio(bytes: number, maxBytes: number): number {
  if (!(bytes > 0) || !(maxBytes > 0)) return 0;
  return Math.min(1, Math.log(bytes + 1) / Math.log(maxBytes + 1));
}

export function exchangeEdgeStrokeWidth(bytes: number, maxBytes: number): number {
  const ratio = magnitudeRatio(bytes, maxBytes);
  return EXCHANGE_EDGE_MIN_WIDTH + (EXCHANGE_EDGE_MAX_WIDTH - EXCHANGE_EDGE_MIN_WIDTH) * ratio;
}

export function exchangeEdgeOpacity(bytes: number, maxBytes: number): number {
  const ratio = magnitudeRatio(bytes, maxBytes);
  return EXCHANGE_EDGE_MIN_OPACITY + (EXCHANGE_EDGE_MAX_OPACITY - EXCHANGE_EDGE_MIN_OPACITY) * ratio;
}
