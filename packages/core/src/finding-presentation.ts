// How each finding type is presented: the one place a finding type's name, board tag, action
// label, clean-check threshold summary and generic recommendation are registered. FINDING_NAMES,
// TYPE_TAG_MAP, getThresholdSummary, findingActionLabel and coreFindingGenericRecommendation all
// read this table.
//
// It sits beside DETECTORS rather than on its entries because the HTML export renders names, tags
// and labels but may not reach detectors.ts (scripts/export-analysis-guard.mjs). The import from
// detectors.ts is type-only, so it is erased at build time. A detector's scope, order and emits
// list stay on its DETECTORS entry; renderers get them through detectorInfoByType().
import type { ThresholdsOf } from './detectors.ts';
import type { Remediation, SkewOrigin } from './finding-types.ts';
import type { FindingOf, FindingType } from './types.ts';

export interface FindingPresentation<T extends FindingType> {
  /** Lowercase human-readable label ("task skew"); the evidence report Title Cases it. */
  name: string;
  /** ALL-CAPS board tag. Several types may share one (every Plan Advisor type is `PLAN`). */
  tag: string;
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

/** A share threshold as captions and caveats state it: 0.005 -> "0.5%", never float noise like 7.000000000000001%. */
export const shareLabel = (share: number): string => `${Math.round(share * 1e6) / 1e4}%`;

// Whether the detector found `key` already logged on for this run. Its switchFix (detectors.ts)
// then worded the row's own text for that case and left the property out of the remediation, so
// a generic line reads the same decision and never recommends a switch the row says is on.
// A finding with no remediation (older or hand-built data) keeps the property wording.
function switchAlreadyOn(finding: { remediation?: Remediation[] }, key: string): boolean {
  return finding.remediation != null && !finding.remediation.some((r) => r.kind === 'conf' && r.key === key);
}

// The properties an idle-capacity finding lowers once dynamic allocation is on, worded as its row
// does: the executor cap, and the floor when the row's remediation lowers it too.
function idleCapacityLowering(f: { remediation?: Remediation[] }): string {
  const lowersFloor = f.remediation?.some((r) => r.kind === 'conf' && r.key === 'spark.dynamicAllocation.minExecutors');
  return ` by lowering spark.dynamicAllocation.maxExecutors${lowersFloor ? ' and spark.dynamicAllocation.minExecutors' : ''}`;
}

// What a shuffle-reading stage's partition-count advice names, read from the row's remediation: the
// property ('property', also for a finding with no remediation), AQE's coalescing settings ('aqe',
// which leave spark.sql.shuffle.partitions out), or the stage's own repartition(n) ('code').
function partitionAdviceKind(f: { remediation?: Remediation[] }): 'property' | 'aqe' | 'code' {
  if (f.remediation == null || f.remediation.some((r) => r.kind === 'conf' && r.key === 'spark.sql.shuffle.partitions')) return 'property';
  if (f.remediation.some((r) => r.kind === 'conf' && r.key.startsWith('spark.sql.adaptive.'))) return 'aqe';
  return f.remediation.some((r) => r.kind === 'code') ? 'code' : 'property';
}

const SKEW_JOIN_KEY = 'spark.sql.adaptive.skewJoin.enabled';
const SKEW_JOIN_ALREADY_ON = 'AQE skew-join handling is already on, so salt the key or repartition on a better key.';
const SKEW_JOIN_AQE_OFF = 'AQE is off, so enable it (spark.sql.adaptive.enabled) for skew-join handling to apply; otherwise salt the key or repartition on a better key.';

// The skew-join generic line, worded per the row's remediation: AQE logged off, switch already on, or neither.
function skewJoinGeneric(f: { remediation?: Remediation[]; origin?: SkewOrigin }, unset: string): string {
  if (f.origin === 'inputScan') return 'Uneven input files: compact small files or split large ones (lower spark.sql.files.maxPartitionBytes).';
  if (f.origin === 'other') return 'Work is uneven across tasks: salt the key or repartition on a better key.';
  if (f.remediation?.some((r) => r.kind === 'conf' && r.key === 'spark.sql.adaptive.enabled')) return SKEW_JOIN_AQE_OFF;
  return switchAlreadyOn(f, SKEW_JOIN_KEY) ? SKEW_JOIN_ALREADY_ON : unset;
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

const DYNAMIC_ALLOCATION_KEY = 'spark.dynamicAllocation.enabled';

// The three configAudit DETECTORS entries share this row, one per audited property.
const CONFIG_AUDIT_PRESENTATION: FindingPresentation<'configAudit'> = {
  name: 'config audit',
  tag: 'CFG',
  thresholdSummary: () => 'a Spark conf value outside the recommended range',
  actionLabel(f) {
    switch (f.property) {
      case 'spark.dynamicAllocation.maxExecutors': return 'Set max executors';
      case 'spark.serializer': return 'Switch to Kryo';
      case 'spark.executor.memoryOverhead': return 'Raise memory overhead';
    }
    return undefined;
  },
  genericRecommendation(f) {
    switch (f.property) {
      case 'spark.dynamicAllocation.maxExecutors': return 'Set spark.dynamicAllocation.maxExecutors to cap cluster growth.';
      case 'spark.serializer': return 'Consider spark.serializer=org.apache.spark.serializer.KryoSerializer for faster, smaller buffers.';
      case 'spark.executor.memoryOverhead': return 'Raise executor memoryOverhead above the default Spark would have computed to avoid off-heap OOM-kills.';
    }
    return undefined;
  },
};

/** One row per emitted finding type: the mapped type makes a missing or stray row a compile error. */
export const FINDING_PRESENTATION: { readonly [T in FindingType]: FindingPresentation<T> } = {
  incompleteRun: {
    name: 'incomplete run',
    tag: 'INCMP',
    thresholdSummary: () => 'an event log missing its terminal ApplicationEnd event',
    actionLabel: () => undefined,
    genericRecommendation: () => undefined,
  },

  skew: {
    name: 'task skew',
    tag: 'SKEW',
    thresholdSummary: (t) => `P95 task time over ${t.ratioWarn}× the median (the longest task on stages under ${t.minTasksForP95} tasks), and the slow tasks read correspondingly more data`,
    actionLabel: () => 'Fix task skew',
    genericRecommendation: (f) => skewJoinGeneric(f,
      'For join-driven skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.'),
  },
  stageShape: {
    name: 'stage shape',
    tag: 'SHAPE',
    thresholdSummary: (t) => `under ${t.pRatioMax} tasks per core, output over ${t.oiRatioMax}× input, or one task spanning over ${Math.round(t.stageShareMin * 100)}% of the stage's wall-clock at over ${t.skewWarn}× the median task`,
    actionLabel(f) {
      switch (f.rule) {
        case 'lowParallelism': return 'Increase parallelism';
        case 'dataExplosion': return 'Check for exploding join';
        case 'taskStageSkew': return 'Fix straggler task';
      }
      return undefined;
    },
    genericRecommendation(f) {
      switch (f.rule) {
        case 'lowParallelism': return 'Too few tasks run relative to the cores available, leaving cluster capacity idle: repartition to use more of it.';
        case 'dataExplosion': return 'Output volume far exceeds input volume: check for an exploding join or a cross product.';
        case 'taskStageSkew': return 'A single straggler task gates the whole stage\'s wall-clock duration.';
      }
      return undefined;
    },
  },
  tinyTask: {
    name: 'tiny tasks',
    tag: 'TINY',
    thresholdSummary: (t) => `${t.minTasks}+ tasks with a median of ${t.maxP50}ms or less and a P95 of ${t.maxP95}ms or less`,
    actionLabel: () => 'Coalesce small tasks',
    genericRecommendation(f) {
      if (f.reads != null && f.reads !== 'shuffle') return 'Scheduler overhead may dominate: coalesce down to fewer, larger tasks.';
      switch (partitionAdviceKind(f)) {
        case 'aqe': return 'Scheduler overhead may dominate: AQE already coalesced the shuffle, so set spark.sql.adaptive.coalescePartitions.parallelismFirst to false or raise spark.sql.adaptive.advisoryPartitionSizeInBytes, or coalesce down to fewer, larger tasks.';
        case 'code': return "Scheduler overhead may dominate: this stage's own repartition(n) or RDD parallelism sized it, so lower that count or coalesce down to fewer, larger tasks.";
        default: return 'Scheduler overhead may dominate: lower spark.sql.shuffle.partitions, or coalesce down to fewer, larger tasks.';
      }
    },
  },

  shuffle: {
    name: 'shuffle I/O',
    tag: 'SHFL',
    thresholdSummary: (t) => `stage shuffle read above ${t.minBytes / 1048576} MiB`,
    actionLabel: () => 'Reduce shuffle size',
    genericRecommendation: (f) => {
      switch (f.partitions) {
        case 'sufficient': return 'The tasks are already a good size, so more partitions will not help: use a broadcast join for the smaller side.';
        case 'aqeCoalesced': return 'AQE coalesced the shuffle: lower spark.sql.adaptive.advisoryPartitionSizeInBytes, or use a broadcast join for the smaller side.';
        case 'ownPartitioning': return "spark.sql.shuffle.partitions is already high enough, so raise this stage's own partition count (its repartition(n) or RDD parallelism), or use a broadcast join for the smaller side.";
        default: return 'Raise spark.sql.shuffle.partitions, or use a broadcast join for the smaller side.';
      }
    },
  },
  partitionSizing: {
    name: 'partition sizing',
    tag: 'PART',
    thresholdSummary: (t) => `a shuffle partition over ${t.skewRatio}× the median or over ${t.maxPartBytes / 1073741824} GiB, or ${t.lowParTotalBytes / 1073741824} GiB of shuffle on ${t.lowParMaxTasks} tasks or fewer`,
    actionLabel(f) {
      switch (f.rule) {
        case 'shufflePartitionSkew': return 'Fix skewed partition';
        case 'lowShuffleParallelism': return 'Add shuffle partitions';
        case 'maxPartitionTooBig': return 'Repartition oversized data';
      }
      return undefined;
    },
    genericRecommendation(f) {
      switch (f.rule) {
        case 'shufflePartitionSkew': return skewJoinGeneric(f, 'For join skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.');
        case 'lowShuffleParallelism':
          if (f.partitions === 'aqeCoalesced') return 'AQE coalesced the shuffle into few tasks: lower spark.sql.adaptive.advisoryPartitionSizeInBytes so each partition is smaller.';
          return switchAlreadyOn(f, 'spark.sql.shuffle.partitions')
          ? "spark.sql.shuffle.partitions is already high enough, so raise this stage's own partition count (its repartition(n) or RDD parallelism) so each partition is smaller."
          : 'Raise spark.sql.shuffle.partitions so each partition is smaller.';
        case 'maxPartitionTooBig': return 'Repartition to break up the oversized partition before this stage.';
      }
      return undefined;
    },
  },

  spill: {
    name: 'spill',
    tag: 'SPILL',
    thresholdSummary: (t) => `single-task disk spill above ${t.singleTaskDiskGiB} GiB`,
    actionLabel: () => 'Reduce spill',
    // The skew/volume classification isn't a Finding field, so one sentence covers both.
    genericRecommendation(f) {
      const skewFirst = 'If the spill is skew-driven, fix task skew first: adding memory will not help. Otherwise';
      if (f.reads != null && f.reads !== 'shuffle') return `${skewFirst} increase executor memory or process less data per task.`;
      switch (partitionAdviceKind(f)) {
        case 'aqe': return `${skewFirst} lower spark.sql.adaptive.advisoryPartitionSizeInBytes so AQE's merged partitions are smaller, or increase executor memory.`;
        case 'code': return `${skewFirst} raise this stage's own partition count (its repartition(n) or RDD parallelism), or increase executor memory.`;
        default: return `${skewFirst} raise spark.sql.shuffle.partitions or increase executor memory.`;
      }
    },
  },

  gc: {
    name: 'GC pressure',
    tag: 'GC',
    thresholdSummary: (t) => `GC above ${t.warnPct100}% (or below ${t.lowInfoPct100}%) of executor run time`,
    actionLabel: (f) => (f.direction === 'low' ? 'Right-size executor memory' : 'Reduce GC pressure'),
    genericRecommendation: (f) => (f.direction === 'low'
      ? 'Memory may be over-provisioned here: consider reducing spark.executor.memory for cost savings.'
      : 'Reduce object creation, use primitive types, avoid UDFs, or increase executor memory to cut GC time.'),
  },

  stageFailed: {
    name: 'failed stage',
    tag: 'SFAIL',
    thresholdSummary: () => 'a stage that failed outright',
    actionLabel: () => 'Inspect stage failure',
    genericRecommendation: () => 'Inspect the driver log for the failure reason and the job that triggered it.',
  },
  failures: {
    name: 'failed tasks',
    tag: 'FAIL',
    thresholdSummary: (t) => `over ${shareLabel(t.warnRate)} of a stage's tasks failing`,
    actionLabel: () => 'Investigate task failures',
    genericRecommendation: () => 'Investigate driver logs for executor instability or data-driven errors.',
  },
  retryWaste: {
    name: 'retry waste',
    tag: 'RETRY',
    thresholdSummary: (t) => `${t.minWasted}+ retried attempts wasting at least ${t.minWasteMs / 1000}s`,
    actionLabel: () => 'Investigate retry cause',
    genericRecommendation: () => 'Investigate executor loss or fetch failures behind the retried attempts.',
  },

  slowHost: {
    name: 'slow executor host',
    tag: 'HOST',
    thresholdSummary: (t) => `a host ${t.ratioWarn}× slower than its peers by mean task time (per-executor figures from ${t.ratioTiers[0]}×)`,
    actionLabel(f) {
      if (f.variant === 'durationShare') return 'Fix data locality';
      if (f.variant === 'multiDim') return 'Investigate degraded executor';
      return 'Check slow host';
    },
    genericRecommendation(f) {
      if (f.variant === 'durationShare') return 'Check for data locality or partition assignment skewing work onto one node.';
      if (f.variant === 'multiDim') return 'Investigate uneven partition assignment or a degraded executor.';
      const check = 'Check what this host was running: it may just hold data locality for its tasks or carry one heavy stage, rather than a hardware fault.';
      return switchAlreadyOn(f, 'spark.speculation')
        ? `${check} Speculation is already on, so a lagging task there is already relaunched.`
        : `${check} Enable spark.speculation to relaunch a lagging task automatically.`;
    },
  },
  stageSlowness: {
    name: 'slow stage',
    tag: 'SLOW',
    thresholdSummary: () => 'a stage running far longer than its peers, not attributable to a single slow host',
    actionLabel: () => 'Profile slow stage',
    genericRecommendation(f) {
      if (f.reads === 'input') return 'Often too few or too uneven input partitions: check input file sizes and lower spark.sql.files.maxPartitionBytes, or look for a large per-task data volume driving heavy spill.';
      if (f.reads === 'other') return 'Check what the stage computes and for a large per-task data volume driving heavy spill.';
      const spill = 'or check for a large per-task data volume driving heavy shuffle and spill.';
      switch (partitionAdviceKind(f)) {
        case 'aqe': return `Often a partition-count problem: AQE coalesced the shuffle, so lower spark.sql.adaptive.advisoryPartitionSizeInBytes to get more tasks, ${spill}`;
        case 'code': return `Often a partition-count problem: raise this stage's own partition count (its repartition(n) or RDD parallelism), ${spill}`;
        default: return `Often a partition-count problem: raise spark.sql.shuffle.partitions, ${spill}`;
      }
    },
  },
  straggler: {
    name: 'straggling task',
    tag: 'STRAG',
    thresholdSummary: () => 'one or more tasks finishing far after the rest of their stage, for a reason other than reading more data',
    actionLabel: () => 'Fix stragglers',
    genericRecommendation: (f) => f.cause === 'data' ? `Uneven data volume drives the slow tasks: ${skewJoinGeneric(f, 'for join-driven skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.')}`
      : f.cause === 'gc' ? 'GC accounts for most of the slow tasks\' extra time: reduce object creation, use primitive types, avoid UDFs, increase executor memory.'
      : f.cause === 'fetchWait' ? 'Waiting on shuffle fetches accounts for most of the slow tasks\' extra time: look for a slow or overloaded node serving shuffle blocks, executors lost mid-stage, or reducers fetching many small blocks.'
      : f.cause === 'host' ? 'Most slow tasks ran on one host: check what it was running, and consider enabling spark.speculation to relaunch a lagging task automatically.'
      : f.cause === 'unexplained' ? 'The slow tasks read no more data than the median task, and GC, shuffle fetch wait and one slow host do not account for their time: look at per-record cost (UDFs, regular expressions, a call out per row).'
      : `Rule out a GC pause or a slow shuffle fetch before assuming a hardware issue. If uneven data is the cause: ${skewJoinGeneric(f, 'for join-driven skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.')}`,
  },
  speculationWaste: {
    name: 'speculation waste',
    tag: 'SPEC',
    thresholdSummary: (t) => `${t.minWasted}+ discarded speculative attempts wasting at least ${t.minWasteMs / 1000}s`,
    actionLabel: () => 'Tune speculation settings',
    genericRecommendation: () => 'If task durations are naturally variable rather than genuine stragglers, consider tuning spark.speculation.multiplier/quantile.',
  },
  coldStart: {
    name: 'cold start',
    tag: 'COLD',
    thresholdSummary: (t) => `the first stage waiting over ${t.gapSeconds}s for an executor`,
    actionLabel: () => 'Pre-warm cluster',
    genericRecommendation: (f) => (f.dynamicAllocation === 'off'
      ? 'Keep a warm pool of idle executors: dynamic allocation is off, so no executor-count property applies.'
      : 'Keep a warm pool of idle executors, or if using dynamic allocation, raise the minimum/initial executor count so it does not scale up from zero.'),
  },

  memoryUtilization: {
    name: 'memory utilization',
    tag: 'MEM',
    thresholdSummary: () => 'executor heap usage outside the configured band',
    actionLabel(f) {
      switch (f.variant) {
        case 'idleCores': return 'Reduce idle cores';
        case 'wasteModel': return 'Right-size executor memory';
        case 'memoryBand':
          if (f.dataUnavailable) return 'Executor heap peaks unavailable';
          return 'Reduce executor memory';
      }
      return undefined;
    },
    genericRecommendation(f) {
      switch (f.variant) {
        case 'idleCores': return switchAlreadyOn(f, DYNAMIC_ALLOCATION_KEY)
          ? `Dynamic allocation is already on, so reduce cluster size${idleCapacityLowering(f)}.`
          : 'Either reduce cluster size (spark.executor.instances) or enable dynamic allocation.';
        case 'wasteModel': return 'Review spark.executor.memory and executor count.';
        case 'memoryBand':
          if (f.dataUnavailable) return undefined;
          return 'Memory may be over-provisioned: consider reducing spark.executor.memory for cost savings.';
      }
      return undefined;
    },
  },
  utilization: {
    name: 'executor utilization',
    tag: 'UTIL',
    thresholdSummary: (t) => `average executor utilization below ${shareLabel(t.minUtil)}`,
    actionLabel: () => 'Reduce cluster size',
    genericRecommendation: (f) => (switchAlreadyOn(f, DYNAMIC_ALLOCATION_KEY)
      ? `Dynamic allocation is already on, so consider reducing cluster size${idleCapacityLowering(f)}.`
      : 'Consider either reducing cluster size (spark.executor.instances) or enabling dynamic allocation.'),
  },
  coreLocality: {
    name: 'core locality',
    tag: 'LOCAL',
    thresholdSummary: () => 'task placement missing data-local core assignment',
    actionLabel: () => 'Fix data locality',
    genericRecommendation: () => 'Check executor/data colocation.',
  },
  cachingOpportunity: {
    name: 'caching opportunity',
    tag: 'CACHE',
    thresholdSummary: () => 'a dataset re-read from source multiple times with no cache/persist',
    actionLabel: (f) => (f.variant === 'composite' ? 'Cache repeated result' : 'Cache shared table'),
    genericRecommendation: (f) => (f.variant === 'composite'
      ? 'Cache or persist the repeated join/union result so it is computed once instead of recomputed per query.'
      : 'Cache the shared DataFrame, or broadcast it if it is a small join lookup.'),
  },
  cacheUtilization: {
    name: 'cache utilization',
    tag: 'CSTOR',
    thresholdSummary: () => 'cached partitions evicted or spilled to disk',
    actionLabel: (f) => (f.dataUnavailable ? 'Enable block-update logging' : 'Increase cache memory'),
    genericRecommendation(f) {
      switch (f.variant) {
        case 'partialCache': return 'Increase executor memory or reduce the cached dataset size so more of it stays cached.';
        case 'diskSpillover': return 'Executor memory may be too small for this cached dataset: increase executor memory or reduce its size.';
      }
      return undefined;
    },
  },
  jobFailureRate: {
    name: 'job failure rate',
    tag: 'JOBS',
    thresholdSummary: (t) => `at least ${shareLabel(t.infoRate)} of jobs failing`,
    actionLabel: () => 'Investigate failed jobs',
    genericRecommendation: () => 'Inspect the driver log for the failed job(s) and the stage failures that triggered them.',
  },
  autoscalingChurn: {
    name: 'autoscaling churn',
    tag: 'CHRN',
    thresholdSummary: (t) => `over ${shareLabel(t.warningPct)} of executors living under ${t.shortLivedMs / 60000} minutes`,
    actionLabel: () => 'Reduce autoscaling churn',
    genericRecommendation: (f) => (f.dynamicAllocation === 'off'
      ? 'Dynamic allocation is off, so the churn comes from executors lost or preempted: check the cluster manager\'s preemption and executor-loss logs.'
      : 'This looks like wasteful re-provisioning rather than normal scale-down: consider raising spark.dynamicAllocation.executorIdleTimeout or widening the minExecutors/maxExecutors bounds to reduce flapping.'),
  },

  configAudit: CONFIG_AUDIT_PRESENTATION,

  duplicatePlanSubtree: {
    name: 'duplicate plan subtree',
    tag: 'PLAN',
    thresholdSummary: () => 'the same physical plan subtree executed more than once',
    actionLabel: () => 'Dedupe repeated subtree',
    // isExchangeRoot isn't a Finding field, so one sentence covers both cases.
    genericRecommendation: () => 'Check whether the repeated subtree could be computed once and reused, or cache/persist the shared computation.',
  },
  smallFiles: {
    name: 'small files',
    tag: 'PLAN',
    thresholdSummary: (t) => `over ${t.minFiles} files averaging under ${t.maxAvgFileSizeMB} MiB`,
    actionLabel: (f) => (f.direction === 'write' ? 'Coalesce output files' : 'Compact small files'),
    genericRecommendation: (f) => (f.direction === 'write'
      ? 'Repartition or coalesce before writing to raise the average file size.'
      : 'Compact the upstream output so fewer, larger files are produced.'),
  },
  nestedLoopJoin: {
    name: 'nested loop join',
    tag: 'PLAN',
    thresholdSummary: (t) => `a nested-loop or cartesian join with over ${t.minOutputRows.toLocaleString('en-US')} output rows, at least ${t.minExpansion}x its larger input`,
    actionLabel: (f) => (f.condition == null ? 'Confirm cross join' : 'Add an equi-join key'),
    genericRecommendation: (f) => (f.condition == null
      ? 'Confirm the cross join is intended, or add a join key so the rows are matched instead of multiplied.'
      : 'Add an equi-join key so Spark can use a hash or sort-merge join; for a range condition, bucket the range and join on the bucket as well.'),
  },
  underBroadcast: {
    name: 'missed broadcast join',
    tag: 'PLAN',
    thresholdSummary: () => 'a join below the configured size floor that skipped broadcast',
    actionLabel: () => 'Use broadcast join',
    genericRecommendation: (f) => (f.broadcastThreshold === 'notLimiting'
      ? 'The threshold already admits the smaller side, so it is not what stopped the broadcast: consider a broadcast() hint or collecting table statistics.'
      : 'This could have been a broadcast join: consider a broadcast() hint or raising spark.sql.autoBroadcastJoinThreshold.'),
  },
  overBroadcast: {
    name: 'oversized broadcast join',
    tag: 'PLAN',
    thresholdSummary: (t) => `a broadcast over ${t.overBroadcastBytes / 1073741824} GiB`,
    actionLabel: () => 'Fix oversized broadcast',
    genericRecommendation: (f) => (f.broadcastThreshold === 'notLimiting'
      ? 'The configured threshold is below this broadcast, so remove the broadcast() hint that forced it.'
      : switchAlreadyOn(f, 'spark.sql.autoBroadcastJoinThreshold')
      ? 'Automatic broadcast is already disabled, so remove the broadcast() hint that forced it.'
      : 'Check for a misapplied broadcast hint or a misconfigured spark.sql.autoBroadcastJoinThreshold.'),
  },
};

/** The presentation row for a free-form type string (report JSON, a filter, a test double). */
export function presentationOf(type: string): FindingPresentation<FindingType> | undefined {
  return (FINDING_PRESENTATION as Readonly<Record<string, FindingPresentation<FindingType>>>)[type];
}
