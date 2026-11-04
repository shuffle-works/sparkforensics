// How each finding type is presented: a finding type's name, board tag, action label, clean-check
// threshold summary and generic recommendation. Each detector folder holds its own row in
// detectors/<type>/presentation.ts; this module assembles them into one table. FINDING_NAMES,
// TYPE_TAG_MAP, getThresholdSummary, findingActionLabel and coreFindingGenericRecommendation all
// read it.
//
// The rows sit beside the detector entries rather than on them because the HTML export renders
// names, tags and labels but may not reach detectors.ts or a folder's detect.ts
// (scripts/export-analysis-guard.mjs). The imports of detector code are type-only, so they are
// erased at build time. A detector's scope, order and emits list stay on its DETECTORS entry;
// renderers get them through detectorInfoByType().
import type { ThresholdsOf } from './detectors.ts';
import type { FindingOf, FindingType } from './types.ts';
import * as incompleteRun from './detectors/incomplete-run/presentation.ts';
import * as skew from './detectors/skew/presentation.ts';
import * as stageShape from './detectors/stage-shape/presentation.ts';
import * as tinyTask from './detectors/tiny-task/presentation.ts';
import * as shuffle from './detectors/shuffle/presentation.ts';
import * as partitionSizing from './detectors/partition-sizing/presentation.ts';
import * as spill from './detectors/spill/presentation.ts';
import * as gc from './detectors/gc/presentation.ts';
import * as stageFailed from './detectors/stage-failed/presentation.ts';
import * as failures from './detectors/failures/presentation.ts';
import * as retryWaste from './detectors/retry-waste/presentation.ts';
import * as slowHost from './detectors/slow-host/presentation.ts';
import * as stageSlowness from './detectors/stage-slowness/presentation.ts';
import * as straggler from './detectors/straggler/presentation.ts';
import * as speculationWaste from './detectors/speculation-waste/presentation.ts';
import * as coldStart from './detectors/cold-start/presentation.ts';
import * as memoryUtilization from './detectors/memory-utilization/presentation.ts';
import * as utilization from './detectors/utilization/presentation.ts';
import * as rightSizing from './detectors/right-sizing/presentation.ts';
import * as coreLocality from './detectors/core-locality/presentation.ts';
import * as cachingOpportunity from './detectors/caching-opportunity/presentation.ts';
import * as cacheUtilization from './detectors/cache-utilization/presentation.ts';
import * as jobFailureRate from './detectors/job-failure-rate/presentation.ts';
import * as autoscalingChurn from './detectors/autoscaling-churn/presentation.ts';
import * as configAudit from './detectors/config-audit/presentation.ts';
import * as duplicatePlanSubtree from './detectors/duplicate-plan-subtree/presentation.ts';
import * as smallFiles from './detectors/small-files/presentation.ts';
import * as pythonUdf from './detectors/python-udf/presentation.ts';
import * as nestedLoopJoin from './detectors/nested-loop-join/presentation.ts';
import * as joinKeyCast from './detectors/join-key-cast/presentation.ts';
import * as mergeRewrite from './detectors/merge-rewrite/presentation.ts';
import * as unprunedScan from './detectors/unpruned-scan/presentation.ts';
import * as broadcastSizing from './detectors/broadcast-sizing/presentation.ts';

/** The outcome a finding type is about, which groups the detector catalog. */
export const DETECTOR_FAMILIES = [
  { id: 'speed', label: 'Speed' },
  { id: 'cost', label: 'Cost' },
  { id: 'reliability', label: 'Reliability' },
  { id: 'plan', label: 'SQL plans' },
  { id: 'setup', label: 'Setup' },
] as const;

export type DetectorFamily = (typeof DETECTOR_FAMILIES)[number]['id'];

export interface FindingPresentation<T extends FindingType> {
  /** Lowercase human-readable label ("task skew"); the evidence report Title Cases it. */
  name: string;
  /** ALL-CAPS board tag. Several types may share one (every Plan Advisor type is `PLAN`). */
  tag: string;
  /** The outcome group of the detector catalog. */
  family: DetectorFamily;
  /** One generic sentence on what the finding means, in Spark terms with no figures or names, for
   * the catalog's cards and pages. */
  pitch: string;
  /** Set for the types the dashboard shows in its reference region, below the action widgets
   * (`REGISTRY` in src/view/detector-registry.tsx reads it). Every other type renders in the
   * action region. */
  region?: 'reference';
  /** The criterion a clean check was measured against, from the emitting entry's own thresholds. */
  thresholdSummary(thresholds: ThresholdsOf<T>): string;
  /** A short imperative label for the finding's row, or undefined for a (type, discriminant)
   * combination this type doesn't recognize; findingActionLabel then falls back to `name`. */
  actionLabel(finding: FindingOf<T>): string | undefined;
  /** The shape of the fix with no instance data (numbers, stage ids, host names, config values),
   * for a multi-finding group's muted line. Undefined where the detector's real branch key isn't a
   * Finding field or the combination is unrecognized; the caller then shows no line. */
  genericRecommendation(finding: FindingOf<T>): string | undefined;
}

/** One line on what a straggler finding's slow tasks lost their time to, for the widget row; null
 * when the log gave no cause (the finding then only knows their duration). */
export function stragglerCauseSummary(f: { cause?: string; causeSharePct?: number; host?: string; hostTasks?: number }): string | null {
  const share = f.causeSharePct != null ? ` (${f.causeSharePct}% of their extra time)` : '';
  switch (f.cause) {
    case 'data': return `The slow tasks read more data${share}`;
    case 'gc': return `GC${share}`;
    case 'fetchWait': return `Waiting on shuffle fetches${share}`;
    case 'host': return `Tasks piled on ${f.host ?? 'one host'}${share}`;
    case 'unexplained': return 'Not data volume, GC, fetch wait or one host';
    default: return null;
  }
}

/** One row per emitted finding type: the mapped type makes a missing or stray row a compile error.
 * `as const` keeps each row's `tag` a literal, which `FindingTag` reads. */
const PRESENTATION_ROWS = {
  ...incompleteRun.presentation,
  ...skew.presentation,
  ...stageShape.presentation,
  ...tinyTask.presentation,
  ...shuffle.presentation,
  ...partitionSizing.presentation,
  ...spill.presentation,
  ...gc.presentation,
  ...stageFailed.presentation,
  ...failures.presentation,
  ...retryWaste.presentation,
  ...slowHost.presentation,
  ...stageSlowness.presentation,
  ...straggler.presentation,
  ...speculationWaste.presentation,
  ...coldStart.presentation,
  ...memoryUtilization.presentation,
  ...utilization.presentation,
  ...rightSizing.presentation,
  ...coreLocality.presentation,
  ...cachingOpportunity.presentation,
  ...cacheUtilization.presentation,
  ...jobFailureRate.presentation,
  ...autoscalingChurn.presentation,
  ...configAudit.presentation,
  ...duplicatePlanSubtree.presentation,
  ...smallFiles.presentation,
  ...pythonUdf.presentation,
  ...nestedLoopJoin.presentation,
  ...joinKeyCast.presentation,
  ...mergeRewrite.presentation,
  ...unprunedScan.presentation,
  ...broadcastSizing.presentation,
} as const satisfies { readonly [T in FindingType]: FindingPresentation<T> };

/** A finding tag the presentation table declares: `TAG_HELP` has exactly one entry for each. */
export type FindingTag = (typeof PRESENTATION_ROWS)[FindingType]['tag'];

export const FINDING_PRESENTATION: { readonly [T in FindingType]: FindingPresentation<T> } = PRESENTATION_ROWS;

/** The presentation row for a free-form type string (report JSON, a filter, a test double). */
export function presentationOf(type: string): FindingPresentation<FindingType> | undefined {
  return (FINDING_PRESENTATION as Readonly<Record<string, FindingPresentation<FindingType>>>)[type];
}

// The metrics findings report, declared once with the unit of each one's `value`. A detector can
// only name a metric from this table, and the formatter reads the unit by that typed key, so a
// metric without a unit does not compile.
//
// 'text' metrics carry `valueText` instead of `value`; 'none' metrics carry neither (the finding
// says its data is unavailable). Neither has a magnitude to show.
export type MetricUnit =
  | 'bytes' | 'ms' | 'seconds' | 'minutes' | 'mbSeconds' | 'ratio' | 'pct' | 'pctFraction' | 'count' | 'text' | 'none';

export const METRICS = {
  // bytes
  shuffleReadBytes: 'bytes', memoryBytesSpilled: 'bytes', shuffleReadMax: 'bytes',
  avgFileSizeBytes: 'bytes', smallerSideBytes: 'bytes', broadcastBytes: 'bytes',
  dataSentBytes: 'bytes', bytesRead: 'bytes', shuffleBytes: 'bytes',
  // durations
  speculationWasteMs: 'ms', retryWasteMs: 'ms', taskDurationP50: 'ms',
  startupGapSeconds: 'seconds',
  stageDurationMinutes: 'minutes',
  wastedMBSeconds: 'mbSeconds',
  // multiples of a median
  'P95/median': 'ratio', 'max/median': 'ratio', pRatio: 'ratio', oiRatio: 'ratio',
  hostMeanRatio: 'ratio', execMaxMedianRatio: 'ratio',
  // percentages on a 0-100 scale
  gcPct: 'pct', failureRate: 'pct', stragglerShare: 'pct', jobFailureRate: 'pct',
  cachedRatio: 'pct', diskRatio: 'pct', avgUtilization: 'pct', idleCoreRate: 'pct',
  heapUsedRatio: 'pct', nonLocalRatio: 'pct', shortLivedExecutorPct: 'pct',
  // fractions on a 0-1 scale
  hostDurationShare: 'pctFraction', taskStageSkew: 'pctFraction',
  // counts
  taskCount: 'count', speculativeTasks: 'count', subtreeOccurrences: 'count',
  persistedRdds: 'count', rightSizedCores: 'count', executionReuse: 'count',
  outputRows: 'count', rewrittenRows: 'count', filesKept: 'count',
  // no magnitude
  stageFailureReason: 'text', applicationEnd: 'text', config: 'text',
  memoryBand: 'none',
} as const satisfies Record<string, MetricUnit>;

export type MetricName = keyof typeof METRICS;

export function metricUnit(metric: MetricName): MetricUnit {
  return METRICS[metric];
}

// Finding type -> ALL-CAPS board tag, derived from FINDING_PRESENTATION. Every widget that renders
// a catalog entry's tag outside its own card (e.g. Bottleneck Alerts) reads it through typeTag.
// Exported so doc-sync checks can enumerate every tag. A free-form type string goes through `typeTag`.
export const TYPE_TAG_MAP = Object.fromEntries(
  (Object.keys(FINDING_PRESENTATION) as FindingType[]).map((type) => [type, FINDING_PRESENTATION[type].tag]),
) as Readonly<Record<FindingType, string>>;

export function typeTag(type: string): string {
  return presentationOf(type)?.tag ?? type.toUpperCase();
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

export { shareLabel, FAILURE_FIX } from './detectors/presentation-shared.ts';
