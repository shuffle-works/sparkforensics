// Stage-granular approximation of core-usage-by-locality over time. Per-task locality is not
// retained, so this distributes each stage's executorRunTime across its wall-clock window,
// split by localityStats proportions. Approximate by construction.
export const LOCALITY_TIERS: string[] = ['PROCESS_LOCAL', 'NODE_LOCAL', 'RACK_LOCAL', 'NO_PREF', 'ANY'];

interface LocalityStage {
  submittedAt?: number;
  completedAt?: number;
  executorRunTime?: number;
  localityStats?: { locality: string; count: number }[];
}

interface LocalityAreaSeriesOptions {
  bucketWidthMs?: number;
  tiers?: string[];
}

interface LocalityAreaSeriesResult {
  labels: number[];
  series: Record<string, number[]>;
}

export function computeLocalityAreaSeries(
  stages: LocalityStage[],
  { bucketWidthMs = 60_000, tiers = LOCALITY_TIERS }: LocalityAreaSeriesOptions = {},
): LocalityAreaSeriesResult {
  const valid = stages.filter(s => (s.completedAt ?? 0) > (s.submittedAt ?? 0) && (s.executorRunTime ?? 0) > 0);
  if (valid.length === 0) return { labels: [], series: {} };
  const startTime = valid.reduce((m, s) => Math.min(m, s.submittedAt ?? m), Infinity);
  const endTime = valid.reduce((m, s) => Math.max(m, s.completedAt ?? m), -Infinity);
  const nBuckets = Math.max(1, Math.ceil((endTime - startTime) / bucketWidthMs));

  const series: Record<string, number[]> = {};
  for (const tier of tiers) series[tier] = new Array(nBuckets).fill(0);
  const other = new Array(nBuckets).fill(0); // localities not in the fixed tier list

  for (const s of valid) {
    const completedAt = s.completedAt ?? 0;
    const submittedAt = s.submittedAt ?? 0;
    const wall = completedAt - submittedAt;
    const avgCores = (s.executorRunTime ?? 0) / wall; // core-time / wall-time = avg concurrent cores
    const total = (s.localityStats ?? []).reduce((a, l) => a + l.count, 0) || 1;
    const props = new Map((s.localityStats ?? []).map(l => [l.locality, l.count / total]));
    // spread avgCores over the buckets this stage overlaps, weighted by overlap fraction
    for (let b = 0; b < nBuckets; b++) {
      const bStart = startTime + b * bucketWidthMs;
      const bEnd = bStart + bucketWidthMs;
      const overlap = Math.min(completedAt, bEnd) - Math.max(submittedAt, bStart);
      if (overlap <= 0) continue;
      const frac = overlap / bucketWidthMs; // portion of the bucket this stage covers
      for (const [loc, p] of props) {
        const add = avgCores * p * frac;
        if (series[loc]) series[loc][b] += add;
        else other[b] += add;
      }
    }
  }
  if (other.some(v => v > 0)) series.OTHER = other;

  // idle = peak total busy across buckets, minus each bucket's total busy.
  const totals = new Array(nBuckets).fill(0);
  for (const tier of Object.keys(series)) for (let b = 0; b < nBuckets; b++) totals[b] += series[tier][b];
  const peak = totals.reduce((m, v) => Math.max(m, v), 0);
  series.idle = totals.map(v => Math.max(0, peak - v));

  const labels: number[] = [];
  for (let b = 0; b < nBuckets; b++) labels.push(startTime + b * bucketWidthMs);
  return { labels, series };
}
