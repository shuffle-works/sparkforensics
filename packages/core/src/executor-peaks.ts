// Per-executor JVM heap peaks from the two places a Spark event log can carry them: the executor
// metrics every TaskEnd reports (Spark 3.0+, always logged) and SparkListenerStageExecutorMetrics
// rows (only with spark.eventLog.logStageExecutorMetrics=true). Spark's own AppStatusListener
// folds the TaskEnd values into executor peak memory
// (https://github.com/apache/spark/blob/v4.0.0/core/src/main/scala/org/apache/spark/status/AppStatusListener.scala).

interface PeakSources {
  stages: Map<number, { executorMetrics?: Map<string, { jvmHeapMemory?: number }> | unknown }>;
  runAggregates?: { executorPeakMetrics?: Record<string, Record<string, number>> } | null;
}

// One analyze() context is asked once per stage detector call: fold it once.
const cache = new WeakMap<object, Map<string, number>>();

/** Executor id to its largest sampled JVMHeapMemory in bytes. Spark polls executor metrics at
 * heartbeat (spark.executor.metrics.pollingInterval defaults to 0), so a peak is a lower bound.
 * JVMHeapMemory is `MemoryMXBean.getHeapMemoryUsage().getUsed()`, which counts uncollected garbage.
 * An executor whose every sample is zero (local mode reports zeros) is left out: no measurement. */
export function executorHeapPeaks(source: PeakSources): Map<string, number> {
  const known = cache.get(source);
  if (known) return known;
  const peaks = new Map<string, number>();
  const take = (executorId: string, heap: unknown): void => {
    // The driver's heap is sized by spark.driver.memory, not the executor setting.
    if (executorId === 'driver') return;
    if (typeof heap === 'number' && heap > (peaks.get(executorId) ?? 0)) peaks.set(executorId, heap);
  };
  for (const [executorId, metrics] of Object.entries(source.runAggregates?.executorPeakMetrics ?? {})) {
    take(executorId, metrics?.jvmHeapMemory);
  }
  for (const stage of source.stages.values()) {
    const rows = stage.executorMetrics;
    if (!(rows instanceof Map)) continue;
    for (const [executorId, metrics] of rows) take(executorId, metrics?.jvmHeapMemory);
  }
  cache.set(source, peaks);
  return peaks;
}
