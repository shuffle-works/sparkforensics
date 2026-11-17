// ETL-phase time attribution. Heuristic: classify each stage by byte-flow shape (a scan-only stage
// is Extract, a stage that moves shuffle bytes is Transform, a stage that writes output bytes is
// Load). Each bucket is the union of its stages' time intervals, so concurrent stages count once and
// a bucket never exceeds wall-clock. A stage can be both Transform and Load, so buckets can overlap
// each other and need not sum to wall-clock. A zero bucket means no stage showed that byte flow.
// Storage-format-aware attribution (Hudi/Delta/Iceberg) isn't portable, out of scope.
interface EtlPhaseStage {
  submittedAt?: number;
  completedAt?: number;
  shuffleReadBytes?: number;
  shuffleWriteBytes?: number;
  inputBytes?: number;
  outputBytes?: number;
}

type Interval = readonly [start: number, end: number];

/** Total length of the union of `intervals`. */
function unionLength(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0] ?? [0, 0];
  for (const [s, e] of sorted.slice(1)) {
    if (s > end) {
      total += end - start;
      [start, end] = [s, e];
    } else {
      end = Math.max(end, e);
    }
  }
  return total + (end - start);
}

export function attributeEtlPhases(
  stages: Map<number, EtlPhaseStage>,
): { extract: number; transform: number; load: number } {
  const extract: Interval[] = [];
  const transform: Interval[] = [];
  const load: Interval[] = [];
  for (const s of stages.values()) {
    const start = s.submittedAt ?? 0;
    const end = s.completedAt ?? 0;
    if (end <= start) continue;
    const shuffled = (s.shuffleReadBytes ?? 0) > 0 || (s.shuffleWriteBytes ?? 0) > 0;
    if ((s.inputBytes ?? 0) > 0 && (s.shuffleReadBytes ?? 0) === 0) extract.push([start, end]); // scan-only
    if (shuffled) transform.push([start, end]);
    if ((s.outputBytes ?? 0) > 0) load.push([start, end]);
  }
  return { extract: unionLength(extract), transform: unionLength(transform), load: unionLength(load) };
}
