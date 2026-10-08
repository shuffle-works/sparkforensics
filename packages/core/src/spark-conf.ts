// The Spark configuration a run actually executed under, resolved key by key from three layers:
//   1. a per-query value: `SparkListenerSQLExecutionStart.modifiedConfigs`, the session settings of
//      one SQL execution that differ from the SparkContext's (what `spark.conf.set` leaves),
//   2. the app's Spark Properties from `SparkListenerEnvironmentUpdate`,
//   3. Spark's own default for the run's Spark version (SPARK_DEFAULTS below).
// A detector scoped to one SQL execution passes that execution's modifiedConfigs; any other caller
// leaves it out and gets the run-wide answer.
//
// Properties with no entry in SPARK_DEFAULTS have no fixed default: spark.executor.instances and
// spark.default.parallelism depend on the cluster manager and the cluster, spark.executor.memoryOverhead
// is derived from spark.executor.memory, spark.dynamicAllocation.initialExecutors from minExecutors,
// and spark.sql.adaptive.autoBroadcastJoinThreshold falls back to spark.sql.autoBroadcastJoinThreshold
// when unset. The lookup returns undefined for them rather than guess.

export type ConfSource = 'query' | 'app' | 'default';

export interface ConfValue {
  value: string;
  source: ConfSource;
}

export interface ConfLayers {
  /** `SparkListenerLogStart.Spark Version`, e.g. "4.0.0"; null or absent when the log lacks it. */
  sparkVersion?: string | null;
  /** The app's Spark Properties. */
  properties?: Readonly<Record<string, string>> | null;
  /** One SQL execution's `modifiedConfigs`. */
  modified?: Readonly<Record<string, string>> | null;
}

type Since = readonly [major: number, minor: number];
type DefaultStep = readonly [since: Since | 'always', value: string];

const ALWAYS = 'always';

// Defaults by the Spark release that introduced them, each key's steps in ascending order. A key
// whose first step is 'always' has that default on every release, including a run whose version the
// log did not record; any other key is only answered for a known version at or after its first
// step (before it the property does not exist). Values are the strings Spark's ConfigBuilder
// declares. Each was read from the SQLConf.scala / config/package.scala sources at the release tags
// from v3.0.0 through v4.2.0, e.g. https://github.com/apache/spark/blob/v4.0.0/core/src/main/scala/org/apache/spark/internal/config/package.scala
const SPARK_DEFAULTS: Readonly<Record<string, readonly DefaultStep[]>> = {
  // Speculation: 4.0.0 moved the multiplier from 1.5 to 3 and the quantile from 0.75 to 0.9.
  'spark.speculation': [[ALWAYS, 'false']],
  'spark.speculation.multiplier': [[ALWAYS, '1.5'], [[4, 0], '3']],
  'spark.speculation.quantile': [[ALWAYS, '0.75'], [[4, 0], '0.9']],

  'spark.executor.memory': [[ALWAYS, '1g']],
  'spark.serializer': [[ALWAYS, 'org.apache.spark.serializer.JavaSerializer']],
  'spark.shuffle.service.enabled': [[ALWAYS, 'false']],
  'spark.eventLog.logBlockUpdates.enabled': [[ALWAYS, 'false']],
  'spark.eventLog.logStageExecutorMetrics': [[ALWAYS, 'false']],

  'spark.dynamicAllocation.enabled': [[ALWAYS, 'false']],
  'spark.dynamicAllocation.minExecutors': [[ALWAYS, '0']],
  'spark.dynamicAllocation.maxExecutors': [[ALWAYS, '2147483647']],
  'spark.dynamicAllocation.executorIdleTimeout': [[ALWAYS, '60s']],

  'spark.sql.shuffle.partitions': [[ALWAYS, '200']],
  'spark.sql.autoBroadcastJoinThreshold': [[ALWAYS, '10MB']],
  'spark.sql.files.maxPartitionBytes': [[ALWAYS, '128MB']],
  // Adaptive query execution is on by default from 3.2.0.
  'spark.sql.adaptive.enabled': [[ALWAYS, 'false'], [[3, 2], 'true']],
  'spark.sql.adaptive.skewJoin.enabled': [[[3, 0], 'true']],
  'spark.sql.adaptive.coalescePartitions.enabled': [[[3, 0], 'true']],
  // Falls back to spark.sql.adaptive.shuffle.targetPostShuffleInputSize, itself 64MB.
  'spark.sql.adaptive.advisoryPartitionSizeInBytes': [[[3, 0], '64MB']],
  // Arrow-optimized Python UDFs: added in 3.4.0 (off), on by default from 4.2.0.
  'spark.sql.execution.pythonUDF.arrow.enabled': [[[3, 4], 'false'], [[4, 2], 'true']],
};

// Spark's spark.redaction.string default, which replaces a sensitive value in modifiedConfigs.
const DEFAULT_REDACTION = '*********(redacted)';

function parseVersion(sparkVersion: string | null | undefined): Since | null {
  const m = /^(\d+)\.(\d+)/.exec(sparkVersion ?? '');
  return m == null ? null : [Number(m[1]), Number(m[2])];
}

/** Spark's default for `key` on `sparkVersion`; undefined when the property has no fixed default,
 * does not exist on that version, or the default depends on a version the log did not record. */
export function sparkConfDefault(sparkVersion: string | null | undefined, key: string): string | undefined {
  const steps = SPARK_DEFAULTS[key];
  if (steps == null) return undefined;
  const version = parseVersion(sparkVersion);
  if (version == null) return steps.length === 1 && steps[0][0] === ALWAYS ? steps[0][1] : undefined;
  let value: string | undefined;
  for (const [since, stepValue] of steps) {
    if (since === ALWAYS || version[0] > since[0] || (version[0] === since[0] && version[1] >= since[1])) value = stepValue;
  }
  return value;
}

/** A per-query setting that can override: not Spark's redaction placeholder for a hidden value. */
function isUsableModified(value: string, properties: Readonly<Record<string, string>> | null | undefined): boolean {
  return value !== (properties?.['spark.redaction.string'] ?? DEFAULT_REDACTION);
}

/** The Spark Properties with one execution's modifiedConfigs applied over them. Returns
 * `properties` itself when there is nothing to apply. */
export function overlayModifiedConfigs(
  properties: Record<string, string> | undefined,
  modified: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> | undefined {
  if (modified == null) return properties;
  const usable = Object.entries(modified).filter(([, value]) => isUsableModified(value, properties));
  return usable.length === 0 ? properties : { ...properties, ...Object.fromEntries(usable) };
}

/** The run's effective value of `key` and the layer it came from, or undefined when no layer has it. */
export function effectiveSparkConf(layers: ConfLayers, key: string): ConfValue | undefined {
  const modified = layers.modified?.[key];
  if (modified !== undefined && isUsableModified(modified, layers.properties)) return { value: modified.trim(), source: 'query' };
  const logged = layers.properties?.[key];
  if (logged !== undefined) return { value: logged.trim(), source: 'app' };
  const fallback = sparkConfDefault(layers.sparkVersion, key);
  return fallback === undefined ? undefined : { value: fallback, source: 'default' };
}

/** A Spark byte-size value as bytes (a plain number, or with a k/m/g/t suffix, optionally 'b'), or
 * null when it is not one. Negative numbers pass through: -1 turns auto-broadcast off. */
export function parseSparkBytes(value: string | undefined): number | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(value?.trim() ?? '');
  if (m == null) return null;
  return m[2] === '' ? Number(m[1]) : Number(m[1]) * 1024 ** ('kmgt'.indexOf(m[2].toLowerCase()) + 1);
}
