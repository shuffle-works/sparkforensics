// Largest and smallest value of a list by loop: `Math.max(...values)` throws a RangeError once the
// spread passes the engine's argument limit (about 150k elements). Null for an empty list.
export function maxOf(values: ArrayLike<number>): number | null {
  if (values.length === 0) return null;
  let max = values[0];
  for (let i = 1; i < values.length; i++) if (values[i] > max) max = values[i];
  return max;
}

export function minOf(values: ArrayLike<number>): number | null {
  if (values.length === 0) return null;
  let min = values[0];
  for (let i = 1; i < values.length; i++) if (values[i] < min) min = values[i];
  return min;
}
