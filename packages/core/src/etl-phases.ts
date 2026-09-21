// §7 ETL-phase time attribution (Onehouse Spark Analyzer). Heuristic: classify each stage by
// byte-flow shape. A stage can be both Transform and Load, so buckets overlap and need not sum to
// wall-clock. Storage-format-aware attribution (Hudi/Delta/Iceberg) isn't portable, out of scope.
interface EtlPhaseStage {
  submittedAt?: number;
  completedAt?: number;
  shuffleReadBytes?: number;
  shuffleWriteBytes?: number;
  inputBytes?: number;
  outputBytes?: number;
}

export function attributeEtlPhases(
  stages: Map<number, EtlPhaseStage>,
): { extract: number; transform: number; load: number } {
  const acc = { extract: 0, transform: 0, load: 0 };
  for (const s of stages.values()) {
    const dur = Math.max(0, (s.completedAt ?? 0) - (s.submittedAt ?? 0));
    if (dur === 0) continue;
    const shuffled = (s.shuffleReadBytes ?? 0) > 0 || (s.shuffleWriteBytes ?? 0) > 0;
    if ((s.inputBytes ?? 0) > 0 && (s.shuffleReadBytes ?? 0) === 0) acc.extract += dur; // scan-only
    if (shuffled) acc.transform += dur;
    if ((s.outputBytes ?? 0) > 0) acc.load += dur;
  }
  return acc;
}
