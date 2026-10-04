// Order-preserving sequence alignment: the weighted longest-common-subsequence dynamic program the
// stage aligner runs over each run's SQL executions. Pure and deterministic.
//
// Cost: the full table has n*m cells and one similarity call per cell. Above `FULL_ALIGNMENT_MAX_CELLS`
// the table is restricted to a band around the diagonal, which costs about n*(2W+1) cells with
// W = `BAND_BASE_HALF_WIDTH` + |n-m|/2, and the result reports that the bounded form ran.

/** Largest n*m the alignment runs in full (1000 x 1000 executions). */
export const FULL_ALIGNMENT_MAX_CELLS = 1_000_000;
/** Band half-width added to half of |n-m| once the table is bounded: the band is centered on the line
 * from corner to corner, and a run of insertions or deletions in one place drifts the best path from
 * that line by at most |n-m|/2. */
export const BAND_BASE_HALF_WIDTH = 100;

export interface SequenceAlignment {
  /** Matched index pairs, ascending in both indexes. */
  pairs: Array<[number, number]>;
  /** True when the table was restricted to a band around the diagonal. */
  bounded: boolean;
}

/** Aligns two sequences of lengths `n` and `m`, maximizing the summed `score` of matched pairs. `score`
 * returns a non-negative integer; a pair scoring below `minScore` is never matched. Of equally good
 * alignments the one that matches whenever matching is optimal wins, and where it must skip, it skips the
 * element with the higher id (`idA`, `idB`), so the lower ids stay and swapping the two sequences mirrors
 * the pairs. */
export function alignSequences(
  n: number, m: number,
  score: (i: number, j: number) => number,
  minScore: number,
  idA: (i: number) => number, idB: (j: number) => number,
): SequenceAlignment {
  if (n === 0 || m === 0) return { pairs: [], bounded: false };
  const bounded = n * m > FULL_ALIGNMENT_MAX_CELLS;
  const half = BAND_BASE_HALF_WIDTH + Math.ceil(Math.abs(n - m) / 2);
  // Row i may match columns lo[i]..hi[i]; both bounds only grow with i.
  const lo = new Int32Array(n), hi = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const center = Math.floor((i * m) / n);
    lo[i] = bounded ? Math.max(0, center - half) : 0;
    hi[i] = bounded ? Math.min(m - 1, center + half) : m - 1;
  }
  // best[i][j - lo[i]]: the best total from the suffixes starting at (i, j), for j inside row i's band.
  const best: Int32Array[] = new Array(n);
  // Cells outside the band are not stored: left of it the row's first cell stands in (those columns can
  // only match in later rows, whose bands start no earlier), right of it the row cannot match, so the
  // next row answers.
  const get = (i: number, j: number): number => {
    for (;;) {
      if (i >= n || j >= m) return 0;
      if (j < lo[i]) j = lo[i];
      else if (j > hi[i]) i++;
      else return best[i][j - lo[i]];
    }
  };
  // The caller memoizes `score`, so the walk below re-asking for visited cells is cheap.
  const cell = score;
  for (let i = n - 1; i >= 0; i--) {
    const row = new Int32Array(hi[i] - lo[i] + 1);
    best[i] = row;
    for (let j = hi[i]; j >= lo[i]; j--) {
      let v = Math.max(get(i + 1, j), j + 1 <= hi[i] ? row[j + 1 - lo[i]] : get(i + 1, j + 1));
      const s = cell(i, j);
      if (s >= minScore) v = Math.max(v, s + get(i + 1, j + 1));
      row[j - lo[i]] = v;
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (j < lo[i]) { j = lo[i]; continue; }
    if (j > hi[i]) { i++; continue; }
    const v = best[i][j - lo[i]];
    const s = cell(i, j);
    if (s >= minScore && s + get(i + 1, j + 1) === v) { pairs.push([i, j]); i++; j++; continue; }
    const skipA = get(i + 1, j) === v, skipB = get(i, j + 1) === v;
    if (skipA && skipB) { if (idA(i) >= idB(j)) i++; else j++; }
    else if (skipA) i++;
    else j++;
  }
  return { pairs, bounded };
}
