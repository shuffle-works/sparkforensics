import type { Finding } from './types.ts';

/** A generic, type-level recommendation sentence for a finding: the shape of the fix, with no
 * instance data (numbers, stage ids, host names, file counts, config values). Mirrors
 * coreFindingActionLabel's (type, discriminant) switch (same fields: rule/direction/variant/
 * property, plus cacheUtilization's variant and memoryUtilization's dataUnavailable), but covers
 * every finding type, not just the ones with a distinct action label.
 *
 * Used for a multi-finding group's muted description line (TypeGroupRow in FixTheseFirst.tsx),
 * where the highest-impact member's own `recommendation` (real numbers, one stage) would
 * misrepresent a summed-impact trailing stat covering every member. Returns undefined where a
 * detector's real branch key isn't exposed as a Finding field (spill's skew/volume
 * classification, tinyTask's shuffle-vs-no-shuffle fix, duplicatePlanSubtree's isExchangeRoot),
 * so those combine into one sentence covering both cases, or for any (type, discriminant)
 * combination this switch doesn't recognize; the caller shows no muted line rather than guess. */
export function coreFindingGenericRecommendation(finding: Finding): string | undefined {
  switch (finding.type) {
    case 'skew':
      return 'For join-driven skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key to reduce task skew.';
    case 'stageShape':
      switch (finding.rule) {
        case 'lowParallelism': return 'Too few tasks run relative to the cores available, leaving cluster capacity idle: repartition to use more of it.';
        case 'dataExplosion': return 'Output volume far exceeds input volume: check for an exploding join or a cross product.';
        case 'taskStageSkew': return 'A single straggler task gates the whole stage\'s wall-clock duration.';
      }
      break;
    case 'shuffle':
      return 'Consider increasing spark.sql.shuffle.partitions or adding a broadcast join to shrink the shuffle.';
    case 'partitionSizing':
      switch (finding.rule) {
        case 'shufflePartitionSkew': return 'For join skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.';
        case 'lowShuffleParallelism': return 'Raise spark.sql.shuffle.partitions so each partition is smaller.';
        case 'maxPartitionTooBig': return 'Repartition to break up the oversized partition before this stage.';
      }
      break;
    case 'spill':
      return 'If the spill is skew-driven, fix task skew first: adding memory will not help. Otherwise raise spark.sql.shuffle.partitions or increase executor memory.';
    case 'gc':
      return finding.direction === 'low'
        ? 'Memory may be over-provisioned here: consider reducing spark.executor.memory for cost savings.'
        : 'Reduce object creation, use primitive types, avoid UDFs, or increase executor memory to cut GC time.';
    case 'slowHost':
      if (finding.variant === 'durationShare') return 'Check for data locality or partition assignment skewing work onto one node.';
      if (finding.variant === 'multiDim') return 'Investigate uneven partition assignment or a degraded executor.';
      return 'Check what this host was running: it may just hold data locality for its tasks or carry one heavy stage, rather than a hardware fault. Enable spark.speculation to relaunch a lagging task automatically.';
    case 'stageSlowness':
      return 'Often a partition-count problem: raise parallelism via spark.sql.shuffle.partitions or spark.default.parallelism, or check for a large per-task data volume driving heavy shuffle and spill.';
    case 'stageFailed':
      return 'Inspect the driver log for the failure reason and the job that triggered it.';
    case 'failures':
      return 'Investigate driver logs for executor instability or data-driven errors.';
    case 'straggler':
      return 'Rule out a GC pause or a slow shuffle fetch before assuming a hardware issue. If a skewed key is the real cause, that is a candidate for AQE\'s skew-join handling.';
    case 'speculationWaste':
      return 'If task durations are naturally variable rather than genuine stragglers, consider tuning spark.speculation.multiplier/quantile.';
    case 'retryWaste':
      return 'Investigate executor loss or fetch failures behind the retried attempts.';
    case 'tinyTask':
      return 'Scheduler overhead may dominate: lower spark.sql.shuffle.partitions, or coalesce down to fewer, larger tasks.';
    case 'coldStart':
      return 'Keep a warm pool of idle executors, or if using dynamic allocation, raise the minimum/initial executor count so it does not scale up from zero.';
    case 'utilization':
      return 'Consider reducing cluster size or enabling dynamic allocation.';
    case 'memoryUtilization':
      switch (finding.variant) {
        case 'idleCores': return 'Reduce cluster size or enable dynamic allocation.';
        case 'wasteModel': return 'Review spark.executor.memory and executor count.';
        case 'memoryBand':
          if (finding.dataUnavailable) break;
          return finding.rule === 'heapNearCapacity'
            ? 'Memory may be too small: raise spark.executor.memory to avoid OOM/spill.'
            : 'Memory may be over-provisioned: consider reducing spark.executor.memory for cost savings.';
      }
      break;
    case 'cacheUtilization':
      switch (finding.variant) {
        case 'partialCache': return 'Increase executor memory or reduce the cached dataset size so more of it stays cached.';
        case 'diskSpillover': return 'Executor memory may be too small for this cached dataset: increase executor memory or reduce its size.';
      }
      break;
    case 'coreLocality':
      return 'Check spark.locality.wait settings and executor/data colocation.';
    case 'autoscalingChurn':
      return 'This looks like wasteful re-provisioning rather than normal scale-down: consider raising spark.dynamicAllocation.executorIdleTimeout or widening the minExecutors/maxExecutors bounds to reduce flapping.';
    case 'cachingOpportunity':
      return finding.variant === 'composite'
        ? 'Cache or persist the repeated join/union result so it is computed once instead of recomputed per query.'
        : 'Cache the shared DataFrame, or broadcast it if it is a small join lookup.';
    case 'jobFailureRate':
      return 'Inspect the driver log for the failed job(s) and the stage failures that triggered them.';
    case 'configAudit':
      switch (finding.property) {
        case 'spark.shuffle.service.enabled': return 'Set spark.shuffle.service.enabled=true so shuffle data survives executor removal.';
        case 'spark.dynamicAllocation.minExecutors': return 'Set the minimum executor bound at or below the maximum.';
        case 'spark.dynamicAllocation.maxExecutors': return 'Set spark.dynamicAllocation.maxExecutors to cap cluster growth.';
        case 'spark.serializer': return 'Consider spark.serializer=org.apache.spark.serializer.KryoSerializer for faster, smaller buffers.';
        case 'spark.executor.memoryOverhead': return 'Raise executor memoryOverhead above Spark\'s default floor to avoid off-heap OOM-kills.';
      }
      break;
    case 'duplicatePlanSubtree':
      return 'Check whether the repeated subtree could be computed once and reused, or cache/persist the shared computation.';
    case 'smallFiles':
      return finding.direction === 'write'
        ? 'Repartition or coalesce before writing to raise the average file size.'
        : 'Compact the upstream output so fewer, larger files are produced.';
    case 'underBroadcast':
      return 'This could have been a broadcast join: consider a broadcast() hint or raising spark.sql.autoBroadcastJoinThreshold.';
    case 'overBroadcast':
      return 'Check for a misapplied broadcast hint or a misconfigured spark.sql.autoBroadcastJoinThreshold.';
  }
  return undefined;
}
