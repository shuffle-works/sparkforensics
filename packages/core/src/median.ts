// The textbook median of values already sorted ascending: the middle value for an odd count, the
// mean of the two middle values for an even one. 0 for an empty list.
export function medianOfSorted(sorted: ArrayLike<number>): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
