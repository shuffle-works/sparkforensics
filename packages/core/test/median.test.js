import { describe, it, expect } from 'vitest';
import { medianOfSorted } from '../src/median.ts';

describe('medianOfSorted', () => {
  it('is the middle value for an odd count and the mean of the two middle values for an even one', () => {
    expect(medianOfSorted([5])).toBe(5);
    expect(medianOfSorted([1, 2, 9])).toBe(2);
    expect(medianOfSorted([137, 219, 257, 28345, 34157, 44374])).toBe(14301);
    expect(medianOfSorted(new Float64Array([1, 3]))).toBe(2);
  });

  it('is 0 for an empty list', () => {
    expect(medianOfSorted([])).toBe(0);
  });
});
