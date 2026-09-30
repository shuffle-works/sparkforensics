import type { ExecutorAddedEvent, ExecutorEvent, SparkAppInfo, Stage } from './types.ts';

const MS_PER_HOUR = 3_600_000;
const MIB_PER_GIB = 1024;
// Spark's documented floor and factor for the default executor memory overhead
// (spark.executor.memoryOverhead = max(factor * executor memory, 384 MiB)).
const MIN_OVERHEAD_MIB = 384;
const DEFAULT_OVERHEAD_FACTOR = 0.1;

export interface Allocation {
  /** Σ over executors of cores x hours alive; null when an executor's cores cannot be resolved. */
  coreHours: number | null;
  /** Σ over executors of (executor memory + overhead) in GiB x hours alive; null without
   * spark.executor.memory in the log. */
  memoryGbHours: number | null;
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

function executorMemoryMiB(app: SparkAppInfo | null): number | null {
  const executor = (app?.resources as { executor?: { memoryMB?: number | null; memoryOverheadMB?: number | null } } | undefined)?.executor;
  const config = app?.config ?? {};
  const memoryMB = executor?.memoryMB ?? null;
  if (memoryMB == null) return null;
  if (config['spark.executor.memoryOverhead'] != null) {
    const overheadMB = executor?.memoryOverheadMB ?? null;
    return overheadMB == null ? null : memoryMB + overheadMB;
  }
  const factor = Number.parseFloat(config['spark.executor.memoryOverheadFactor'] ?? '');
  const overheadFactor = Number.isFinite(factor) && factor > 0 ? factor : DEFAULT_OVERHEAD_FACTOR;
  return memoryMB + Math.max(MIN_OVERHEAD_MIB, Math.round(memoryMB * overheadFactor));
}

/** Allocated core-hours and memory GiB-hours from the executor lifecycle: each executor counts
 * from its ExecutorAdded timestamp to its first later ExecutorRemoved timestamp. One with no
 * removal closes at the application end when the log has one, else at the last timestamp the log
 * records (a cut-off log). Cores are the ExecutorAdded event's Total Cores, else
 * spark.executor.cores; memory is spark.executor.memory plus the overhead (spark.executor.
 * memoryOverhead, else the larger of 384 MiB and spark.executor.memoryOverheadFactor, default
 * 0.1, times the memory).
 * Null, never 0, for a figure whose inputs the log lacks. */
export function computeAllocation(input: AllocationInput): Allocation {
  const added = input.executors.added.filter((e): e is ExecutorAddedEvent => e.kind === 'added');
  if (added.length === 0) return { coreHours: null, memoryGbHours: null };
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
  let coresKnown = true;
  const seen = new Set<string>();
  for (const e of added) {
    if (seen.has(e.executorId)) continue; // a replayed ExecutorAdded is the same executor
    seen.add(e.executorId);
    const removal = (removedAt.get(e.executorId) ?? []).filter((t) => t >= e.timestamp).sort((a, b) => a - b)[0];
    const aliveMs = Math.max(0, (removal ?? closeAt ?? e.timestamp) - e.timestamp);
    const cores = e.totalCores > 0 ? e.totalCores : Number.isFinite(configuredCores) ? configuredCores : null;
    if (cores == null) coresKnown = false; else coreMs += cores * aliveMs;
    memoryMiBMs += (memoryMiB ?? 0) * aliveMs;
  }
  return {
    coreHours: coresKnown ? coreMs / MS_PER_HOUR : null,
    memoryGbHours: memoryMiB != null ? memoryMiBMs / MIB_PER_GIB / MS_PER_HOUR : null,
  };
}
