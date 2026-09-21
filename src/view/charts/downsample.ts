// Even-stride decimation: Recharts renders every point as an SVG node, so cap
// what reaches it. No-op under budget; always keeps first and last point so the
// series' extremes aren't dropped.
export function downsample<T>(points: T[], budget = 2000): T[] {
  if (points.length <= budget) return points;
  if (budget <= 1) return points.length ? [points[0]] : [];

  const lastIndex = points.length - 1;
  const stride = lastIndex / (budget - 1);
  const result: T[] = new Array(budget);
  for (let i = 0; i < budget; i++) {
    result[i] = points[Math.min(lastIndex, Math.round(i * stride))];
  }
  return result;
}
