import type { Finding } from './types.ts';

/** A short, imperative action label for a finding's row. Keyed off finding.type plus whichever
 * discriminant field that detector uses (rule/direction/variant/property). Core-safe (no view
 * import) so the dashboard's wrapper and evidence-report.ts share the same switch. Returns
 * undefined for any combination this switch doesn't cover; the caller decides the fallback. */
export function coreFindingActionLabel(finding: Finding): string | undefined {
  switch (finding.type) {
    case 'skew':
      return 'Fix task skew';
    case 'stageShape':
      switch (finding.rule) {
        case 'lowParallelism': return 'Increase parallelism';
        case 'dataExplosion': return 'Check for exploding join';
        case 'taskStageSkew': return 'Fix straggler task';
      }
      break;
    case 'shuffle':
      return 'Reduce shuffle size';
    case 'partitionSizing':
      switch (finding.rule) {
        case 'shufflePartitionSkew': return 'Fix skewed partition';
        case 'lowShuffleParallelism': return 'Add shuffle partitions';
        case 'maxPartitionTooBig': return 'Repartition oversized data';
      }
      break;
    case 'spill':
      return 'Reduce spill';
    case 'gc':
      return finding.direction === 'low' ? 'Right-size executor memory' : 'Reduce GC pressure';
    case 'slowHost':
      if (finding.variant === 'durationShare') return 'Fix data locality';
      if (finding.variant === 'multiDim') return 'Investigate degraded executor';
      return 'Check slow host';
    case 'stageSlowness':
      return 'Profile slow stage';
    case 'stageFailed':
      return 'Inspect stage failure';
    case 'failures':
      return 'Investigate task failures';
    case 'straggler':
      return 'Fix stragglers';
    case 'speculationWaste':
      return 'Tune speculation settings';
    case 'retryWaste':
      return 'Investigate retry cause';
    case 'tinyTask':
      return 'Coalesce small tasks';
    case 'coldStart':
      return 'Pre-warm cluster';
    case 'utilization':
      return 'Reduce cluster size';
    case 'memoryUtilization':
      switch (finding.variant) {
        case 'idleCores': return 'Reduce idle cores';
        case 'wasteModel': return 'Right-size executor memory';
        case 'memoryBand':
          if (finding.dataUnavailable) return 'Enable memory metrics';
          return finding.rule === 'heapNearCapacity' ? 'Increase executor memory' : 'Reduce executor memory';
      }
      break;
    case 'cacheUtilization':
      return 'Increase cache memory';
    case 'coreLocality':
      return 'Fix data locality';
    case 'autoscalingChurn':
      return 'Reduce autoscaling churn';
    case 'cachingOpportunity':
      return finding.variant === 'composite' ? 'Cache repeated result' : 'Cache shared table';
    case 'jobFailureRate':
      return 'Investigate failed jobs';
    case 'configAudit':
      switch (finding.property) {
        case 'spark.shuffle.service.enabled': return 'Enable shuffle service';
        case 'spark.dynamicAllocation.minExecutors': return 'Fix autoscaling bounds';
        case 'spark.dynamicAllocation.maxExecutors': return 'Set max executors';
        case 'spark.serializer': return 'Switch to Kryo';
        case 'spark.executor.memoryOverhead': return 'Raise memory overhead';
      }
      break;
    case 'duplicatePlanSubtree':
      return 'Dedupe repeated subtree';
    case 'smallFiles':
      return finding.direction === 'write' ? 'Coalesce output files' : 'Compact small files';
    case 'underBroadcast':
      return 'Use broadcast join';
    case 'overBroadcast':
      return 'Fix oversized broadcast';
  }
  return undefined;
}
