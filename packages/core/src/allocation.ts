import { computePeakConcurrentExecutorCount } from './core-count.ts';
import { parseSparkMemoryMB } from './spark-memory.ts';
import type { ExecutorAddedEvent, ExecutorEvent, SparkAppInfo, Stage } from './types.ts';

const MS_PER_HOUR = 3_600_000;
const MS_PER_SECOND = 1000;
const MIB_PER_GIB = 1024;
// Spark's documented floor and factor for the default executor memory overhead
// (spark.executor.memoryOverhead = max(factor * executor memory, 384 MiB)).
const MIN_OVERHEAD_MIB = 384;
const DEFAULT_OVERHEAD_FACTOR = 0.1;

export interface Allocation {
  /** Σ over executors of cores x hours alive; null when an executor's cores cannot be resolved. */
  coreHours: number | null;
  /** Σ over executors of container memory in GiB x hours alive; null when the log records no
   * Spark properties or a memory key cannot be read. */
  memoryGbHours: number | null;
  /** The logged `spark.dynamicAllocation.enabled`: 'on' or 'off' only when the log records the
   * key, null otherwise (Spark's default is off, but an unlogged key is not a logged one). */
  dynamicAllocation: 'on' | 'off' | null;
  /** Peak concurrently-alive executors; null when the log has no executor events. */
  executorsPeak: number | null;
  /** `executorSeconds` over the seconds from application start to close, so the mean times the
   * run's wall clock is `executorSeconds`; null without executor events or an application start. */
  executorsMean: number | null;
  /** Cores per executor when every executor has the same count; null when unknown or mixed. */
  executorCores: number | null;
  /** Σ over executors of seconds alive; null when the log has no executor events. */
  executorSeconds: number | null;
}

export interface AllocationInput {
  app: SparkAppInfo | null;
  stages: Map<number, Stage>;
  executors: { added: ExecutorEvent[]; removed: ExecutorEvent[] };
}

/** The latest timestamp the log records: the application start and end and every stage and
 * executor event. Where a log with no ApplicationEnd stops. */
export function lastObservedTimestamp(input: AllocationInput): number | null {
  let last: number | null = null;
  const take = (t: number | null | undefined): void => {
    if (typeof t === 'number' && Number.isFinite(t) && t > 0 && (last == null || t > last)) last = t;
  };
  take(input.app?.startTime);
  take(input.app?.endTime);
  for (const s of input.stages.values()) { take(s.submittedAt); take(s.completedAt); }
  for (const e of [...input.executors.added, ...input.executors.removed]) take(e.timestamp);
  return last;
}

// Spark's default executor memory when spark.executor.memory is unset.
const DEFAULT_EXECUTOR_MEMORY_MIB = 1024;

// One container's memory in MiB, as Spark requests it from the cluster manager: executor heap,
// plus overhead, plus off-heap and PySpark worker memory when configured. Null when the log
// records no Spark properties (nothing to tell a default from a missing config) or a memory key it
// does record cannot be read.
function executorMemoryMiB(app: SparkAppInfo | null): number | null {
  const config = app?.config;
  if (config == null) return null;
  // undefined: key absent; null: present but unreadable.
  const mib = (key: string): number | null | undefined => (config[key] == null ? undefined : parseSparkMemoryMB(config[key]));
  const heap = mib('spark.executor.memory') ?? (config['spark.executor.memory'] == null ? DEFAULT_EXECUTOR_MEMORY_MIB : null);
  if (heap == null) return null;

  let overhead = mib('spark.executor.memoryOverhead');
  if (overhead === undefined) overhead = mib('spark.yarn.executor.memoryOverhead'); // legacy key
  if (overhead === undefined) {
    const factor = Number.parseFloat(config['spark.executor.memoryOverheadFactor'] ?? '');
    overhead = Math.max(MIN_OVERHEAD_MIB, Math.round(heap * (Number.isFinite(factor) && factor > 0 ? factor : DEFAULT_OVERHEAD_FACTOR)));
  }
  const offHeap = String(config['spark.memory.offHeap.enabled']).toLowerCase() === 'true' ? mib('spark.memory.offHeap.size') ?? 0 : 0;
  const pyspark = mib('spark.executor.pyspark.memory') ?? 0;
  if (overhead === null || offHeap === null || pyspark === null) return null;
  return heap + overhead + offHeap + pyspark;
}

function loggedDynamicAllocation(app: SparkAppInfo | null): 'on' | 'off' | null {
  const raw = app?.config?.['spark.dynamicAllocation.enabled'];
  return raw == null ? null : raw.trim().toLowerCase() === 'true' ? 'on' : 'off';
}

/** Allocated core-hours and memory GiB-hours from the executor lifecycle: each executor counts
 * from its ExecutorAdded timestamp to its first later ExecutorRemoved timestamp. One with no
 * removal closes at the application end when the log has one, else at the last timestamp the log
 * records (a cut-off log). Cores are the ExecutorAdded event's Total Cores, else
 * spark.executor.cores; memory per executor is spark.executor.memory (default 1g) plus the
 * overhead (spark.executor.memoryOverhead, else the legacy spark.yarn.executor.memoryOverhead,
 * else the larger of 384 MiB and spark.executor.memoryOverheadFactor, default 0.1, times the
 * memory), plus spark.memory.offHeap.size when spark.memory.offHeap.enabled is true, plus
 * spark.executor.pyspark.memory.
 * The executor counts and seconds come from the same alive intervals.
 * Null, never 0, for a figure whose inputs the log lacks. */
export function computeAllocation(input: AllocationInput): Allocation {
  const dynamicAllocation = loggedDynamicAllocation(input.app);
  const added = input.executors.added.filter((e): e is ExecutorAddedEvent => e.kind === 'added');
  if (added.length === 0) {
    return { coreHours: null, memoryGbHours: null, dynamicAllocation, executorsPeak: null, executorsMean: null, executorCores: null, executorSeconds: null };
  }
  const removedAt = new Map<string, number[]>();
  for (const e of input.executors.removed) {
    if (e.kind !== 'removed') continue;
    const times = removedAt.get(e.executorId);
    if (times) times.push(e.timestamp); else removedAt.set(e.executorId, [e.timestamp]);
  }
  const closeAt = input.app?.endTime ?? lastObservedTimestamp(input);
  const configuredCores = Number.parseInt(input.app?.config?.['spark.executor.cores'] ?? '', 10);
  const memoryMiB = executorMemoryMiB(input.app);

  let coreMs = 0;
  let memoryMiBMs = 0;
  let aliveMsTotal = 0;
  let coresKnown = true;
  const coreCounts = new Set<number>();
  const unique: ExecutorAddedEvent[] = [];
  const seen = new Set<string>();
  for (const e of added) {
    if (seen.has(e.executorId)) continue; // a replayed ExecutorAdded is the same executor
    seen.add(e.executorId);
    unique.push(e);
    const removal = (removedAt.get(e.executorId) ?? []).filter((t) => t >= e.timestamp).sort((a, b) => a - b)[0];
    const aliveMs = Math.max(0, (removal ?? closeAt ?? e.timestamp) - e.timestamp);
    const cores = e.totalCores > 0 ? e.totalCores : Number.isFinite(configuredCores) ? configuredCores : null;
    aliveMsTotal += aliveMs;
    if (cores == null) coresKnown = false; else { coreMs += cores * aliveMs; coreCounts.add(cores); }
    memoryMiBMs += (memoryMiB ?? 0) * aliveMs;
  }
  const startTime = input.app?.startTime;
  const windowMs = closeAt != null && startTime != null ? closeAt - startTime : 0;
  return {
    coreHours: coresKnown ? coreMs / MS_PER_HOUR : null,
    memoryGbHours: memoryMiB != null ? memoryMiBMs / MIB_PER_GIB / MS_PER_HOUR : null,
    dynamicAllocation,
    executorsPeak: computePeakConcurrentExecutorCount(unique, input.executors.removed),
    executorsMean: windowMs > 0 ? aliveMsTotal / windowMs : null,
    executorCores: coresKnown && coreCounts.size === 1 ? [...coreCounts][0] : null,
    executorSeconds: aliveMsTotal / MS_PER_SECOND,
  };
}
