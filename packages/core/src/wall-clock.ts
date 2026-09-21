export function mergeIntervals(intervals: [number, number][]): [number, number][] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push([cur[0], cur[1]]);
  }
  return out;
}

export function computeWallClock(app: {startTime?: number | null; endTime?: number | null} | null, stages: Map<number, {submittedAt?: number; completedAt?: number}>): {total: number; startup: number; stagesActive: number; gaps: number; idle: number} {
  const start = app?.startTime ?? 0;
  const stageList = [...stages.values()].filter(s => s.submittedAt != null && s.completedAt != null);
  const intervals = stageList.map(s => [s.submittedAt as number, s.completedAt as number]);
  const explicitEnd = app?.endTime ?? null;
  const end = explicitEnd ?? (intervals.length > 0 ? intervals.reduce((m, i) => Math.max(m, i[1]), -Infinity) : start);
  const total = Math.max(0, end - start);

  if (intervals.length === 0) {
    return { total, startup: total, stagesActive: 0, gaps: 0, idle: 0 };
  }

  const merged = mergeIntervals(intervals as [number, number][]);
  const stagesActive = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
  const firstStageStart = merged[0][0];
  const startup = Math.max(0, firstStageStart - start);
  let gaps = 0;
  for (let i = 1; i < merged.length; i++) gaps += merged[i][0] - merged[i - 1][1];
  const lastStageEnd = merged[merged.length - 1][1];
  const idle = Math.max(0, end - lastStageEnd);

  return { total, startup, stagesActive, gaps, idle };
}
