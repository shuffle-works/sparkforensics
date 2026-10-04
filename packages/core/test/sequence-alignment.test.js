import { describe, it, expect } from 'vitest';
import { alignSequences, FULL_ALIGNMENT_MAX_CELLS, BAND_BASE_HALF_WIDTH } from '../src/sequence-alignment.js';

const ids = (i) => i;
// Sequences of labels; two items score 1000 when equal and 0 otherwise.
const align = (a, b, min = 500) => alignSequences(a.length, b.length, (i, j) => (a[i] === b[j] ? 1000 : 0), min, ids, ids);

describe('alignSequences', () => {
  it('keeps the order of the matches and skips what only one side has', () => {
    expect(align(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd']).pairs).toEqual([[0, 0], [2, 1], [3, 3]]);
  });

  it('matches the first iterations of a loop and leaves the extra last one unmatched', () => {
    const loop = (n) => Array.from({ length: n }, () => 'q');
    expect(align(loop(3), loop(5)).pairs).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(align(loop(5), loop(3)).pairs).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it('never matches a pair scoring under the minimum', () => {
    expect(align(['a'], ['b']).pairs).toEqual([]);
    expect(alignSequences(1, 1, () => 400, 500, ids, ids).pairs).toEqual([]);
    expect(alignSequences(1, 1, () => 500, 500, ids, ids).pairs).toEqual([[0, 0]]);
  });

  it('maximizes the summed score, not the number of matches', () => {
    // One strong crossing match beats two weak ones.
    const score = (i, j) => ({ '0,1': 1000, '1,0': 1000, '0,0': 600, '1,1': 600 })[`${i},${j}`] ?? 0;
    expect(alignSequences(2, 2, score, 500, ids, ids).pairs).toEqual([[0, 0], [1, 1]]);
    expect(alignSequences(2, 2, (i, j) => (i === 0 && j === 1 ? 2000 : score(i, j)), 500, ids, ids).pairs).toEqual([[0, 1]]);
  });

  it('breaks a tie by keeping the lower id, so swapping the sequences mirrors the pairs', () => {
    // a = [x, y], b = [y, x]: matching either pair is optimal. The ids differ between the sides, as
    // two runs' execution ids usually do; equal ids on a self-mirrored tie have no mirror-symmetric answer.
    const a = ['x', 'y'], b = ['y', 'x'];
    const idA = (i) => i, idB = (j) => 10 + j;
    const forward = alignSequences(2, 2, (i, j) => (a[i] === b[j] ? 1000 : 0), 500, idA, idB).pairs;
    const backward = alignSequences(2, 2, (i, j) => (b[i] === a[j] ? 1000 : 0), 500, idB, idA).pairs;
    expect(forward).toHaveLength(1);
    expect(backward.map(([i, j]) => [j, i])).toEqual(forward);
  });

  it('handles an empty side', () => {
    expect(alignSequences(0, 3, () => 1000, 500, ids, ids)).toEqual({ pairs: [], bounded: false });
  });

  it('runs in full up to the cell limit and in a band beyond it', () => {
    const side = Math.floor(Math.sqrt(FULL_ALIGNMENT_MAX_CELLS));
    expect(alignSequences(side, side, (i, j) => (i === j ? 1000 : 0), 500, ids, ids).bounded).toBe(false);
    const n = side + 1;
    const banded = alignSequences(n, n, (i, j) => (i === j ? 1000 : 0), 500, ids, ids);
    expect(banded.bounded).toBe(true);
    expect(banded.pairs).toHaveLength(n);
  });

  it('finds a shift inside the band and misses one beyond it', () => {
    const n = 1200, shift = BAND_BASE_HALF_WIDTH - 10;
    // The second sequence is the first with `shift` extra leading items.
    const within = alignSequences(n, n + shift, (i, j) => (j - shift === i ? 1000 : 0), 500, ids, ids);
    expect(within.bounded).toBe(true);
    expect(within.pairs).toHaveLength(n);
    const far = 2 * BAND_BASE_HALF_WIDTH + 500;
    const beyond = alignSequences(n, n + far, (i, j) => (j - far === i ? 1000 : 0), 500, ids, ids);
    expect(beyond.pairs.length).toBeLessThan(n);
  });
});
