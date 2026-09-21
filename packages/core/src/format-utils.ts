const TARGET_PARTITION_BYTES = 128 * 1024 * 1024;
const MAX_RECOMMENDED = 8000;
const MEANINGFUL_RATIO = 1.5;

export const VISIBLE_LIMIT: number = 6;
export const IMPACT_BAND_ORDER: Record<'critical' | 'warning' | 'info', number> = { critical: 0, warning: 1, info: 2 };

const BOTTLENECK_WIDGET: Record<string, string> = {
  skew: 'task-skew', slowHost: 'task-skew', straggler: 'task-skew',
  shuffle: 'shuffle-io', spill: 'spill', gc: 'gc-pressure', failures: 'failures',
  coldStart: 'executor-timeline', utilization: 'executor-timeline', speculationWaste: 'executor-timeline',
};

// Cross-widget stage recurrence: how many distinct board widgets (skew+straggler on one stage
// still count as one, task-skew) flag a stage. Computed once from the full catalog each widget
// already receives.
// `stageId` may be number|null|undefined: sql/config-scope findings never set it; `stageId == null`
// below treats both the same.
export function stageWidgetFrequency(catalog: Array<{stageId?: number | null; type: string}>): Map<number, number> {
  const perStage = new Map();
  for (const b of catalog) {
    if (b.stageId == null) continue;
    const widget = BOTTLENECK_WIDGET[b.type];
    if (!widget) continue;
    if (!perStage.has(b.stageId)) perStage.set(b.stageId, new Set());
    perStage.get(b.stageId).add(widget);
  }
  const freq = new Map();
  for (const [stageId, widgets] of perStage) freq.set(stageId, widgets.size);
  return freq;
}

// Canonical detector type -> ALL-CAPS board tag vocabulary. Single source of truth for every
// widget that renders a catalog entry's tag outside its own card (e.g. Bottleneck Alerts).
// Exported so doc-sync checks can enumerate every tag without hand-duplicating this list.
export const TYPE_TAG_MAP: Record<string, string> = {
  skew: 'SKEW', shuffle: 'SHFL', spill: 'SPILL', gc: 'GC',
  coldStart: 'COLD', utilization: 'UTIL', memoryUtilization: 'MEM',
  cacheUtilization: 'CSTOR', coreLocality: 'LOCAL', autoscalingChurn: 'CHRN',
  slowHost: 'HOST', failures: 'FAIL', straggler: 'STRAG',
  retryWaste: 'RETRY', tinyTask: 'TINY', stageFailed: 'SFAIL',
  speculationWaste: 'SPEC',
  partitionSizing: 'PART', stageSlowness: 'SLOW', stageShape: 'SHAPE',
  cachingOpportunity: 'CACHE', jobFailureRate: 'JOBS', configAudit: 'CFG',
  duplicatePlanSubtree: 'PLAN', smallFiles: 'PLAN', underBroadcast: 'PLAN', overBroadcast: 'PLAN',
  broadcastSizing: 'PLAN',
  incompleteRun: 'INCMP',
};

export function typeTag(type: string): string {
  return TYPE_TAG_MAP[type] ?? type.toUpperCase();
}

// Human-readable tooltips for the terse spill-classification badges (skew | vol | ?), surfaced via
// title=. Kept domain-agnostic (Spark-internal terms only).
export const SPILL_CLASS_TITLE = {
  skew: 'Skew spill: a few heavy tasks spill while most do not; rebalance partitioning',
  volume: 'Volume spill: most tasks spill because data exceeds memory; add partitions',
  unclassified: 'Spill cause could not be classified',
};

// Short badge text, kept distinct from the long-form SPILL_CLASS_TITLE tooltip. Shared by
// Spill.tsx's per-row badge and StageTable.tsx's spill-column cell.
export const SPILL_CLASS_SHORT: Record<keyof typeof SPILL_CLASS_TITLE, string> = {
  skew: 'skew', volume: 'vol', unclassified: '?',
};

const DEFAULT_MAX_STAGE_IDS_SHOWN = 8;

// Caps a stage-id list's printed length: a sql-scope finding's stageIds can run into the hundreds,
// and joined raw that length balloons an auto-layout table's column width. Shared by FixTheseFirst
// and PlanFindings.
export function formatStageIdsLabel(stageIds: number[], maxShown: number = DEFAULT_MAX_STAGE_IDS_SHOWN): string {
  if (stageIds.length <= maxShown) return stageIds.join(', ');
  return `${stageIds.slice(0, maxShown).join(', ')}, +${stageIds.length - maxShown} more`;
}

/** Worst (lowest IMPACT_BAND_ORDER) impact band across findings, undefined when empty. Shared by
 * every widget that badges/colors a group of findings.
 * @param {{ impactBand: 'critical' | 'warning' | 'info' }[]} findings
 * @returns {'critical' | 'warning' | 'info' | undefined} */
export function worstImpactBand(
  findings: { impactBand: 'critical' | 'warning' | 'info' }[],
): 'critical' | 'warning' | 'info' | undefined {
  let worst;
  for (const f of findings) {
    if (worst === undefined || IMPACT_BAND_ORDER[f.impactBand] < IMPACT_BAND_ORDER[worst]) worst = f.impactBand;
  }
  return worst;
}

export function escHtml(str: unknown): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Reduces an embedded HDFS/S3/absolute-path fragment to its basename (e.g. "... hdfs://host/a/b/c"
// -> "c"). Strings with no such fragment pass through unchanged; NOT a general truncator.
export function pathBasename(str: unknown): string {
  const s = String(str);
  const m = s.match(/((?:hdfs?|s3[an]?):\/\/\S+|\/[^\s,)]+)/i);
  if (!m) return s;
  const segs = m[1].replace(/[/,]+$/, '').split('/').filter(Boolean);
  return segs[segs.length - 1] || s;
}

// "collect at /u02/.../utils.py:1869" -> "collect at utils.py:1869". Splits on the last " at "
// (Spark's callsite format), then reduces the location to its basename via pathBasename (whose
// match keeps a trailing ":<line>").
export function trimCallsite(callsite: string): string {
  const idx = callsite.lastIndexOf(' at ');
  if (idx === -1) return callsite;
  const operation = callsite.slice(0, idx);
  const location = callsite.slice(idx + 4);
  return `${operation} at ${pathBasename(location)}`;
}

// recent-files ids are `${name}::${size}::${lastModified}`: show just the name. Preferred over
// app.name, which is usually identical across the two compared runs.
export function runLabel(id: string): string {
  return id.split('::')[0] || id;
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

// Spark reports some duration fields (e.g. executorCpuTime) in nanoseconds
// while most of this codebase works in milliseconds; convert at the source
// rather than trusting call sites to remember the unit.
export function nsToMs(ns: number): number {
  return ns / 1e6;
}

// Finding.value is number|string only because a couple of detectors (configAudit, stageFailed)
// report a string; every other row formatter needs the numeric case and falls back to 0.
export function numericValue(f: { value?: number | string }): number {
  return typeof f.value === 'number' ? f.value : 0;
}

// Low-level "number -> display string" step shared by every widget's per-finding label resolver:
// each keeps its own type/metric routing and calls this only for the final value-to-string step,
// so the same number renders identically ("42%", "2.3×") everywhere.
export function formatMetricValue(unit: 'pct' | 'pctFraction' | 'ratio' | 'ms' | 'count', value: number): string {
  switch (unit) {
    case 'pct': return `${value}%`;
    // 'pct' expects an already-scaled 0-100 value (every detector's Finding.value convention); this
    // variant is for the rare metric (slowHost's hostDurationShare) whose value is a raw 0-1 fraction.
    case 'pctFraction': return `${Math.round(value * 100)}%`;
    case 'ratio': return `${value}×`;
    case 'ms': return formatDuration(value);
    case 'count': return `${value}`;
  }
}

// Finding.metric -> display unit, for the compact plan-graph finding chip. Keyed by the exact
// `metric` string each per-stage/plan-advisor detector writes (see detectors.ts); a metric this map
// doesn't cover, or a non-numeric `value` (stageFailed's failure reason, configAudit's config text),
// yields no magnitude. 'bytes' handles the sub-KB tier formatBytes deliberately lacks; 'minutes'
// converts to ms so it shares formatDuration's phrasing.
const FINDING_METRIC_UNIT: Record<string, 'bytes' | 'ms' | 'minutes' | 'ratio' | 'pct' | 'pctFraction' | 'count'> = {
  shuffleReadBytes: 'bytes', memoryBytesSpilled: 'bytes', shuffleReadMax: 'bytes',
  avgFileSizeBytes: 'bytes', smallerSideBytes: 'bytes', broadcastBytes: 'bytes',
  speculationWasteMs: 'ms', retryWasteMs: 'ms', taskDurationP50: 'ms',
  stageDurationMinutes: 'minutes',
  'P95/median': 'ratio', 'max/median': 'ratio', pRatio: 'ratio', oiRatio: 'ratio',
  taskStageSkew: 'ratio', hostMeanRatio: 'ratio', execMaxMedianRatio: 'ratio',
  gcPct: 'pct', failureRate: 'pct', stragglerShare: 'pct',
  hostDurationShare: 'pctFraction',
  taskCount: 'count', speculativeTasks: 'count', subtreeOccurrences: 'count',
};

// formatBytes floors at KB (its guarded contract, see partition-sizing.test.tsx); the plan-graph
// chip is the one place a sub-KB magnitude is meaningful (a smallFiles avgFileSizeBytes can be a
// few hundred bytes), so render that tier here rather than widening the shared formatter.
function formatChipBytes(bytes: number): string {
  if (bytes > 0 && bytes < 1000) return `${Math.round(bytes)} B`;
  return formatBytes(bytes);
}

/** Compact magnitude for a finding's plan-graph chip (e.g. "4.2 GB", "3.2×", "45%"), taken from the
 * finding's own `value` rendered in its `metric`'s unit. Returns null when `value` is non-numeric
 * (stageFailed/configAudit reuse it for text) or the metric isn't in FINDING_METRIC_UNIT. */
export function formatFindingMagnitude(finding: { metric?: string; value?: number | string }): string | null {
  const unit = finding.metric ? FINDING_METRIC_UNIT[finding.metric] : undefined;
  if (!unit || typeof finding.value !== 'number') return null;
  switch (unit) {
    case 'bytes': return formatChipBytes(finding.value);
    case 'minutes': return formatDuration(finding.value * 60000);
    case 'ms': return formatMetricValue('ms', finding.value);
    case 'ratio': return formatMetricValue('ratio', finding.value);
    case 'pct': return formatMetricValue('pct', finding.value);
    case 'pctFraction': return formatMetricValue('pctFraction', finding.value);
    case 'count': return formatMetricValue('count', finding.value);
  }
}

/** The plan-graph finding chip's detail text: the finding's magnitude and, when a wall-clock
 * recovery is claimed, "~<time>" (the optimistic `high` bound, matching formatImpactEstimateCompact),
 * joined by " · " (e.g. "4.2 GB · ~38.0s"). null when neither part is available. */
export function formatFindingChipDetail(
  finding: { metric?: string; value?: number | string; impactEstimate?: { wallClock?: { low: number; high: number } | null } },
): string | null {
  const magnitude = formatFindingMagnitude(finding);
  const wallClock = finding.impactEstimate?.wallClock;
  const recoverable = wallClock ? `~${formatDuration(wallClock.high)}` : null;
  const parts = [magnitude, recoverable].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function recommendPartitions(stage: {shuffleReadBytes?: number; taskCount?: number}): {recommended: number; current: number} | null {
  const bytes = stage.shuffleReadBytes ?? 0;
  if (bytes <= 0) return null;
  const recommended = Math.min(MAX_RECOMMENDED, Math.ceil(bytes / TARGET_PARTITION_BYTES));
  const current = stage.taskCount ?? 0;
  if (recommended <= current * MEANINGFUL_RATIO) return null;
  return { recommended, current };
}

export function buildHistogram(values: number[], bins: number): {labels: number[]; data: number[]} {
  if (values.length === 0) return { labels: [], data: [] };
  let min = values[0], max = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  const binSize = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(Math.floor((v - min) / binSize), bins - 1)]++;
  const labels = counts.map((_, i) => Math.round(min + i * binSize));
  return { labels, data: counts };
}
