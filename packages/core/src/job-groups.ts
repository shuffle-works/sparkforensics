// §8 Concurrent-job-group reliability guard. Groups jobs by SQL
// execution id (jobs with none form singleton groups). If two DIFFERENT groups' intervals overlap,
// wall-clock-based estimates become unreliable. Jobs WITHIN a group overlapping (AQE) is normal.
export function checkConcurrentJobGroups(jobs: Map<number, {id?: number; sqlExecutionId?: number|null; submissionTime?: number|null; completionTime?: number|null}> | null): {wallClockReliable: boolean; overlappingGroupIds: [string, string][]} {
  const list = jobs ? [...jobs.values()] : [];
  // Build one interval per group: [min submission, max completion].
  const groups = new Map(); // key -> { start, end }
  let singletonSeq = 0;
  for (const j of list) {
    if (j.submissionTime == null || j.completionTime == null) continue;
    const key = j.sqlExecutionId != null ? `sql:${j.sqlExecutionId}` : `job:${j.id ?? singletonSeq++}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { start: j.submissionTime, end: j.completionTime });
    else { g.start = Math.min(g.start, j.submissionTime); g.end = Math.max(g.end, j.completionTime); }
  }

  const entries = [...groups.entries()].sort((a, b) => a[1].start - b[1].start);
  const overlappingGroupIds: [string, string][] = [];
  for (let i = 1; i < entries.length; i++) {
    for (let k = 0; k < i; k++) {
      const [aKey, a] = entries[k];
      const [bKey, b] = entries[i];
      if (b.start < a.end && a.start < b.end) overlappingGroupIds.push([aKey, bKey] as [string, string]);
    }
  }
  return { wallClockReliable: overlappingGroupIds.length === 0, overlappingGroupIds };
}
