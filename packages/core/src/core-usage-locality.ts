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
  /** Latest completion among the stages the series counts: where its last bucket's data ends. */
  endTime: number;
}

export function computeLocalityAreaSeries(
  stages: LocalityStage[],
  { bucketWidthMs = 60_000, tiers = LOCALITY_TIERS }: LocalityAreaSeriesOptions = {},
): LocalityAreaSeriesResult {
  const valid = stages.filter(s => (s.completedAt ?? 0) > (s.submittedAt ?? 0) && (s.executorRunTime ?? 0) > 0);
  if (valid.length === 0) return { labels: [], series: {}, endTime: 0 };
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
  return { labels, series, endTime };
}

/** How many time buckets the Core Usage by Locality chart aims for across a run. */
export const LOCALITY_CHART_TARGET_BUCKETS = 60;

export interface LocalityChartPoint {
  /** Seconds from app start. */
  t: number;
  [tier: string]: number;
}

export type LocalityChart =
  | { hasActivity: false }
  | { hasActivity: true; order: string[]; points: LocalityChartPoint[]; peakCores: number };

/** The Core Usage by Locality chart's points and its "busy at the peak" figure, shared by the
 * dashboard widget and the CLI/MCP run summary. Buckets are at least a minute wide; a last bucket
 * the stages only partly cover is rescaled to the covered part, and each bucket's idle cores are
 * the peak minus its busy cores. */
export function buildLocalityChart(
  stages: LocalityStage[],
  app: { startTime?: number | null; endTime?: number | null } | null,
  targetBuckets: number = LOCALITY_CHART_TARGET_BUCKETS,
): LocalityChart {
  const hasActivity = stages.some((s) => (s.executorRunTime ?? 0) > 0 && (s.completedAt ?? 0) > (s.submittedAt ?? 0));
  if (!hasActivity) return { hasActivity: false };

  const start = app?.startTime ?? 0;
  const end = app?.endTime ?? start;
  const bucketWidthMs = Math.max(60_000, Math.ceil(Math.max(1, end - start) / targetBuckets));
  const { labels, series, endTime: seriesEnd } = computeLocalityAreaSeries(stages, { bucketWidthMs });
  const order = [...LOCALITY_TIERS.filter((t) => series[t]), ...(series.OTHER ? ['OTHER'] : []), 'idle'];

  const points: LocalityChartPoint[] = labels.map((t, i) => {
    const point: LocalityChartPoint = { t: Math.round((t - start) / 1000) };
    // The series averages each bucket over its full width, so a last bucket
    // that runs past the series' own end (or a run shorter than one bucket)
    // reads diluted: a 10s stage in a 60s bucket showed well under its busy
    // cores. Rescale to the part of the bucket the series actually covers.
    const coveredMs = Math.min(bucketWidthMs, seriesEnd - t);
    const scale = bucketWidthMs / coveredMs;
    for (const tier of order) if (tier !== 'idle') point[tier] = (series[tier]?.[i] ?? 0) * scale;
    return point;
  });
  const busyTiers = order.filter((t) => t !== 'idle');
  const busyTotal = (p: LocalityChartPoint) => busyTiers.reduce((sum, t) => sum + p[t], 0);
  const peakCores = points.reduce((max, p) => Math.max(max, busyTotal(p)), 0);
  // Same rule as the core series (peak busy minus each bucket's busy), redone
  // on the rescaled values so the stack still tops out at the peak.
  for (const p of points) p.idle = Math.max(0, peakCores - busyTotal(p));
  return { hasActivity: true, order, points, peakCores };
}

/** Whole cores from 10 up; one decimal below, so a small run's peak never
 * rounds down to "0 cores". */
export function formatCores(cores: number): string {
  return cores >= 10 ? String(Math.round(cores)) : cores.toFixed(1).replace(/\.0$/, '');
}
