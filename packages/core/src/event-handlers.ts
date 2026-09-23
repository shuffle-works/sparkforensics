import { z } from 'zod';
import {
  SparkEventSchema,
  ApplicationStartEventSchema,
  EnvironmentUpdateEventSchema,
  JobStartEventSchema,
  JobEndEventSchema,
  StageSubmittedEventSchema,
  StageExecutorMetricsEventSchema,
  TaskEndEventSchema,
  SqlExecutionStartEventSchema,
  SqlAdaptiveExecutionUpdateEventSchema,
  SqlExecutionEndEventSchema,
  DriverAccumUpdatesEventSchema,
  ExecutorAddedEventSchema,
  ExecutorRemovedEventSchema,
  type SparkEvent,
  type SparkPlanInfo,
} from './event-schemas.ts';
import { assertNever } from './assert-never.ts';
import { finalizeStage } from './stage-quantiles.ts';
import { computeRunAggregates } from './run-aggregates.ts';
import type {
  Job, ExecutorAddedEvent, ExecutorRemovedEvent, PlanNode, SparkAppInfo, EvidenceInputs,
} from './types';

// Internal parser-state shapes: the real runtime objects the handlers build and mutate, not the
// public AppModel types in types.ts (which describe the posted message shape after
// finalizeStage/appMessage reshape things).

interface ResourcesSummary {
  executor: {
    memory: string | null;
    memoryMB: number | null;
    memoryOverhead: string | null;
    memoryOverheadMB: number | null;
    cores: number | null;
    instances: number | null;
  };
  driver: {
    memory: string | null;
    memoryMB: number | null;
    memoryOverhead: string | null;
    memoryOverheadMB: number | null;
    cores: number | null;
  };
  dynamicAllocationEnabled: boolean | null;
  shuffleServiceEnabled: boolean | null;
  serializer: string | null;
  // SparkAppInfo.resources is Record<string, unknown>: an index signature keeps this assignable
  // there without a cast.
  [key: string]: unknown;
}

interface RddInfoRecord {
  id: number;
  name: string;
  callsite: string;
  storageLevel: { useDisk: boolean; useMemory: boolean; deserialized: boolean; replication: number };
  numPartitions: number;
  numCachedPartitions: number;
  memorySize: number;
  diskSize: number;
  stageIds: Set<number>;
}

type PostableRddInfoRecord = Omit<RddInfoRecord, 'stageIds'> & { stageIds: number[] };

export interface FailedTaskSample {
  taskId: number | null;
  attemptNumber: number;
  host: string;
  executorId: string;
  reason: string | null;
  peakExecMem: number;
  memSpilled: number;
  shuffleWrite: number;
}

// Cap for both StageRecord.retryTaskSamples (populated here, live during ingest) and
// stage.failedTaskSamples (populated in stage-quantiles.ts's finalizeStage): a starting judgment
// call, not empirically validated against a pathological case. Kept as a separate constant in each
// file rather than a shared import, to avoid a circular value import between the two modules
// (event-handlers.ts already imports finalizeStage FROM stage-quantiles.ts).
const MAX_TASK_SAMPLES = 20;

// One accumulated task-attempt record, keyed by `<stageAttemptId>:<index>` (or a unique Symbol
// when the raw event has no Index).
interface TaskRecord {
  duration: number;
  failed: boolean;
  taskId: number | null;
  attemptNumber: number;
  launchTime: number;
  finishTime: number;
  reason: string | null;
  speculative: boolean;
  host: string;
  executorId: string;
  locality: string | null;
  peakExecMem: number;
  gcTime: number;
  memSpilled: number;
  diskSpilled: number;
  shuffleRead: number;
  shuffleWrite: number;
  fetchWaitTime: number;
  executorRunTime: number;
  executorCpuTime: number;
  inputBytes: number;
  outputBytes: number;
}

interface StageRecord {
  id: number;
  name: string;
  details: string;
  submittedAt: number;
  completedAt: number;
  taskCount: number;
  failedTasks: number;
  shuffleReadBytes: number;
  shuffleWriteBytes: number;
  fetchWaitTime: number;
  memoryBytesSpilled: number;
  diskBytesSpilled: number;
  jvmGCTime: number;
  executorRunTime: number;
  executorCpuTime: number;
  inputBytes: number;
  outputBytes: number;
  sqlExecutionId: number | null;
  parentIds: number[];
  hostStats: Map<string, unknown>;
  speculativeTasks: number;
  failureReasons: Map<string, number>;
  stageFailureReason: string | null;
  taskAttempts: Map<string | symbol, TaskRecord> | null;
  retryTaskSamples: FailedTaskSample[];
  retryWasteMs: number;
  wastedAttempts: number;
  speculationWasteMs: number;
  speculationWastedAttempts: number;
  executorMetrics: Map<string, Record<string, number>>;
}

interface SqlExecutionRecord {
  id: number;
  description: string;
  startTime: number;
  endTime: number | null;
  stageIds: number[];
  // Released (set to null) by endSqlExecution once the plan tree is resolved and posted.
  sparkPlanInfo: SparkPlanInfo | null;
  // Set by applyAdaptiveExecutionUpdate when AQE re-plans this execution mid-run; a per-execution
  // signal for "did this SQL execution receive at least one AQE re-plan."
  hadAdaptiveUpdate: boolean;
}

export interface ParserState {
  app: SparkAppInfo | null;
  pendingSparkVersion: string | null;
  pendingConfig: Record<string, string> | null;
  pendingResources: ResourcesSummary | null;
  stages: Map<number, StageRecord>;
  taskStore: Map<number, Float64Array>;
  sqlExecutions: Map<number, SqlExecutionRecord>;
  stageToSqlExec: Map<number, number>;
  sqlExecStages: Map<number, Set<number>>;
  jobs: Map<number, Job>;
  executors: { added: ExecutorAddedEvent[]; removed: ExecutorRemovedEvent[] };
  skippedLines: number;
  accumState: Map<number, Map<number, number>>;
  rddInfo: Map<number, RddInfoRecord>;
  taskAccumStages: Map<number, Set<number>>;
  evidenceInputs: EvidenceInputs;
}

// Splits decompressed byte chunks into NDJSON lines. Each chunk is decoded whole in one streaming
// TextDecoder.decode call (per-line decode was ~8x slower: 227k calls vs ~36k on a 138MB / 3.5GB
// log), then newlines are found with String.prototype.indexOf on that fresh, flat decoded text.
// A '\n' char is exactly the 0x0A byte (0x0A never occurs inside a UTF-8 multibyte sequence), and
// `{ stream: true }` reassembles a character split across a chunk boundary, so no byte-to-UTF-16
// offset mapping is needed. Only the first line of a chunk joins the carried-over `pending` text.
//
// Measured 2026-09-23 against the previous raw-byte-scan version (identical output): 3.5s -> 2.8s
// on that 3.5GB all-ASCII log, 0.37s -> 0.18s on 93MB of synthetic 2/3/4-byte-heavy NDJSON.
export function buildChunkDecoder() {
  const decoder = new TextDecoder('utf-8');
  // Decoded partial line after the last newline, carried to the next chunk.
  let pending = '';

  return {
    decode(buffer: Uint8Array): string[] {
      const lines: string[] = [];
      const text = decoder.decode(buffer, { stream: true });
      let nl = text.indexOf('\n');
      if (nl === -1) {
        pending = pending === '' ? text : pending + text;
        return lines;
      }
      // Zero-length lines are dropped to match a `.filter(l => l.length)`.
      const first = pending === '' ? text.substring(0, nl) : pending + text.substring(0, nl);
      if (first.length > 0) lines.push(first);
      let start = nl + 1;
      nl = text.indexOf('\n', start);
      while (nl !== -1) {
        if (nl > start) lines.push(text.substring(start, nl));
        start = nl + 1;
        nl = text.indexOf('\n', start);
      }
      pending = start < text.length ? text.substring(start) : '';
      return lines;
    },
    flush(): string[] {
      // Flush any incomplete trailing character the streaming decoder still holds.
      const last = (pending + decoder.decode()).trim();
      pending = '';
      return last ? [last] : [];
    },
  };
}

export function createState(): ParserState {
  return {
    app: null,
    pendingSparkVersion: null,
    pendingConfig: null,
    pendingResources: null,
    stages: new Map(),
    taskStore: new Map(),
    sqlExecutions: new Map(),
    stageToSqlExec: new Map(),
    sqlExecStages: new Map(),
    jobs: new Map(),
    executors: { added: [], removed: [] },
    skippedLines: 0,
    accumState: new Map(),
    rddInfo: new Map(),
    taskAccumStages: new Map(),
    evidenceInputs: {
      environmentUpdates: 0,
      applicationEnds: 0,
      stageSubmissions: 0,
      rddStorageSnapshots: 0,
      sqlExecutions: 0,
      resolvedSqlPlans: 0,
      executorMetricRows: 0,
      taskRecords: 0,
    },
  };
}

// Normalize the `Spark Properties` payload of SparkListenerEnvironmentUpdate. Modern Spark emits
// an object of key->value; older logs use [key, value] pairs. Both collapse to a string->string
// map; the schema tolerates bare number/boolean values, coerced to string to keep the contract.
type SparkPropertyValue = string | number | boolean;
export function normalizeSparkProperties(
  props: Record<string, SparkPropertyValue> | [string, SparkPropertyValue][] | null | undefined
): Record<string, string> {
  if (Array.isArray(props)) {
    const map: Record<string, string> = {};
    for (const pair of props) {
      if (Array.isArray(pair) && pair.length >= 2) map[pair[0]] = String(pair[1]);
    }
    return map;
  }
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    map[key] = String(value);
  }
  return map;
}

// Parse a Spark memory-size string to MiB. Spark's JVM-memory configs use bytesConf(ByteUnit.MiB),
// so a bare number means MiB. A k/m/g/t suffix sets the unit (trailing "b" redundant); a lone "b"
// ("10b") means bytes.
export function parseSparkMemoryMB(value: unknown): number | null {
  if (value == null) return null;
  const m = String(value).trim().toLowerCase().match(/^([\d.]+)\s*([kmgt]?)(b?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'k': return Math.round(n / 1024);
    case 'g': return Math.round(n * 1024);
    case 't': return Math.round(n * 1024 * 1024);
    case 'm': return Math.round(n);
    default: return m[3] === 'b' ? Math.round(n / (1024 * 1024)) : Math.round(n);
  }
}

// Derive an allocated-resource summary from the Spark config map. Absent keys degrade to null,
// not guessed defaults.
export function extractResources(config: Record<string, string> | null | undefined): ResourcesSummary {
  const cfg = config ?? {};
  const int = (k: string) => {
    if (cfg[k] == null) return null;
    const n = parseInt(cfg[k], 10);
    return Number.isFinite(n) ? n : null;
  };
  const memMB = (k: string) => (cfg[k] != null ? parseSparkMemoryMB(cfg[k]) : null);
  const bool = (k: string) => (cfg[k] != null ? String(cfg[k]).toLowerCase() === 'true' : null);
  return {
    executor: {
      memory: cfg['spark.executor.memory'] ?? null,
      memoryMB: memMB('spark.executor.memory'),
      memoryOverhead: cfg['spark.executor.memoryOverhead'] ?? null,
      memoryOverheadMB: memMB('spark.executor.memoryOverhead'),
      cores: int('spark.executor.cores'),
      instances: int('spark.executor.instances'),
    },
    driver: {
      memory: cfg['spark.driver.memory'] ?? null,
      memoryMB: memMB('spark.driver.memory'),
      memoryOverhead: cfg['spark.driver.memoryOverhead'] ?? null,
      memoryOverheadMB: memMB('spark.driver.memoryOverhead'),
      cores: int('spark.driver.cores'),
    },
    dynamicAllocationEnabled: bool('spark.dynamicAllocation.enabled'),
    shuffleServiceEnabled: bool('spark.shuffle.service.enabled'),
    serializer: cfg['spark.serializer'] ?? null,
  };
}

// Convert the live rddInfo Map (with a mutable stageIds Set) into a postable copy with stageIds
// as a sorted array, so the main thread never receives a live Set that could keep mutating after post.
function snapshotRddInfo(rddInfo: Map<number, RddInfoRecord>): Map<number, PostableRddInfoRecord> {
  const out = new Map<number, PostableRddInfoRecord>();
  for (const [id, r] of rddInfo) {
    out.set(id, { ...r, stageIds: [...r.stageIds].sort((a, b) => a - b) });
  }
  return out;
}

function snapshotEvidenceInputs(state: ParserState): EvidenceInputs {
  return { ...state.evidenceInputs };
}

/**
 * Snapshots the evidence counters and posts an `app` message. Called from ApplicationStart,
 * EnvironmentUpdate, and ApplicationEnd, so every streaming `app` message carries a snapshot at
 * that moment. Only emitParseCompletion's terminal snapshot is authoritative; mid-parse ones are
 * partial. Only called once state.app is assigned (all callers guard on it), hence the non-null assertion.
 */
function appMessage(state: ParserState): { type: 'app'; data: Record<string, unknown> } {
  const evidenceInputs = snapshotEvidenceInputs(state);
  state.app!.evidenceInputs = evidenceInputs;
  return {
    type: 'app',
    data: { ...state.app!, rddInfo: snapshotRddInfo(state.rddInfo) },
  };
}

function taskRecordToSample(t: TaskRecord): FailedTaskSample {
  return {
    taskId: t.taskId, attemptNumber: t.attemptNumber, host: t.host, executorId: t.executorId,
    reason: t.reason, peakExecMem: t.peakExecMem, memSpilled: t.memSpilled, shuffleWrite: t.shuffleWrite,
  };
}

export function accumulateTask(event: z.infer<typeof TaskEndEventSchema>, state: ParserState): null {
  const stageId = event['Stage ID'];
  const stage = state.stages.get(stageId);
  if (!stage) return null;
  // Late TaskEnd for a stage whose StageCompleted already freed taskAttempts (finalizeStage): its
  // stats are already baked into the finalized stage, don't re-add.
  if (stage.taskAttempts === null) return null;

  state.evidenceInputs.taskRecords++;

  const accumulables = event['Task Info']?.Accumulables ?? [];
  for (const acc of accumulables) {
    if (!state.taskAccumStages.has(acc.ID)) state.taskAccumStages.set(acc.ID, new Set());
    state.taskAccumStages.get(acc.ID)!.add(stageId);
  }

  // 'Task Info' and its Failed/Killed/Speculative fields are optional in the schema; Partial<>
  // lets the {} fallback type-check while reads below default via ??/||.
  type TaskInfoRaw = Partial<NonNullable<z.infer<typeof TaskEndEventSchema>['Task Info']>>;
  const info: TaskInfoRaw = event['Task Info'] ?? {};
  const m = event['Task Metrics'] ?? {};
  const sr = m['Shuffle Read Metrics'] ?? {};
  const sw = m['Shuffle Write Metrics'] ?? {};
  const inp = m['Input Metrics'] ?? {};
  const out = m['Output Metrics'] ?? {};

  const duration = (info['Finish Time'] ?? 0) - (info['Launch Time'] ?? 0);
  const failed = !!(info['Failed'] || info['Killed']);

  const record: TaskRecord = {
    duration, failed,
    taskId: info['Task ID'] ?? null,
    attemptNumber: info['Attempt Number'] ?? 0,
    launchTime: info['Launch Time'] ?? 0,
    finishTime: info['Finish Time'] ?? 0,
    reason: event['Task End Reason']?.['Reason'] ?? null,
    speculative: info['Speculative'] === true,
    host: info['Host'] ?? '',
    executorId: info['Executor ID'] ?? '',
    locality: info['Locality'] ?? null,
    peakExecMem: m['Peak Execution Memory'] ?? 0,
    gcTime: m['JVM GC Time'] ?? 0,
    memSpilled: m['Memory Bytes Spilled'] ?? 0,
    diskSpilled: m['Disk Bytes Spilled'] ?? 0,
    shuffleRead: (sr['Remote Bytes Read'] ?? 0) + (sr['Local Bytes Read'] ?? 0),
    shuffleWrite: sw['Shuffle Bytes Written'] ?? 0,
    fetchWaitTime: sr['Fetch Wait Time'] ?? 0,
    executorRunTime: m['Executor Run Time'] ?? 0,
    executorCpuTime: m['Executor CPU Time'] ?? 0,
    inputBytes: inp['Bytes Read'] ?? 0,
    outputBytes: out['Bytes Written'] ?? 0,
  };

  // Dedupe only when Index is present (always true for real logs). Without it every event is a
  // distinct task, preserving behavior for fixtures that omit Index.
  const index = info['Index'];
  const key: string | symbol = index != null ? `${event['Stage Attempt ID'] ?? 0}:${index}` : Symbol('no-index');
  const existing = stage.taskAttempts.get(key);

  if (!existing) {
    stage.taskAttempts.set(key, record);
  } else if (existing.failed && !record.failed) {
    // A retry succeeded where the earlier attempt failed: the earlier attempt's time was wasted.
    // Spark marks only the speculative COPY's Speculative flag, never the original it raced, so
    // check both sides to catch "original loses to twin" and "twin loses to original" either way.
    if (existing.speculative || record.speculative) {
      stage.speculationWasteMs += existing.duration;
      stage.speculationWastedAttempts++;
    } else {
      stage.retryWasteMs += existing.duration;
      stage.wastedAttempts++;
      if (stage.retryTaskSamples.length < MAX_TASK_SAMPLES) {
        stage.retryTaskSamples.push(taskRecordToSample(existing));
      }
    }
    stage.taskAttempts.set(key, record);
  } else {
    // Non-winning duplicate (both failed, or a race where a winner is
    // already recorded): its time is waste, its metrics are discarded.
    if (existing.speculative || record.speculative) {
      stage.speculationWasteMs += record.duration;
      stage.speculationWastedAttempts++;
    } else {
      stage.retryWasteMs += record.duration;
      stage.wastedAttempts++;
      if (stage.retryTaskSamples.length < MAX_TASK_SAMPLES) {
        stage.retryTaskSamples.push(taskRecordToSample(record));
      }
    }
  }

  return null;
}

export function resolvePlanTree(
  rootInfo: SparkPlanInfo,
  accumMap: Map<number, number>,
  taskAccumStages: Map<number, Set<number>>,
  executionStageIds: Set<number> | undefined,
  executionId?: number,
): PlanNode {
  const seen = new WeakSet<SparkPlanInfo>();
  const nodeMap = new WeakMap<SparkPlanInfo, PlanNode>();
  let nextId = 0;
  // Prefixed with the owning SQL execution so PlanNode.id is globally unique,
  // not just unique within this one call: two executions' trees can each
  // produce a node named "n1", and a consumer keying off id alone (e.g. a
  // findings-by-nodeId index) must be able to tell them apart without also
  // threading execution scope through separately. No executionId (e.g. the
  // legacy unit tests below) falls back to the old unprefixed "n0", "n1", ...
  // shape.
  const idPrefix = executionId != null ? `e${executionId}:` : '';

  function computeMetricsAndStageIds(info: SparkPlanInfo): {
    metrics: { name: string; value: number; metricType?: string }[];
    stageIds?: number[];
  } {
    const metrics = (info.metrics ?? []).reduce<{ name: string; value: number; metricType?: string }[]>((acc, m) => {
      if (m.accumulatorId !== undefined && accumMap.has(m.accumulatorId)) {
        acc.push({ name: m.name, value: accumMap.get(m.accumulatorId)!, metricType: m.metricType });
      }
      return acc;
    }, []);

    const stageIdSet = new Set<number>();
    for (const m of info.metrics ?? []) {
      if (m.accumulatorId === undefined) continue;
      const stages = taskAccumStages.get(m.accumulatorId);
      if (!stages) continue;
      // Clip to executionStageIds (this execution's own stage set) rather than trusting
      // taskAccumStages wholesale: an accumulator id can be shared with another execution's
      // stages (e.g. a reused subquery re-executes the same accumulator-tagged operator under
      // a different SQL execution id), and without this clip a plan node here would pick up
      // stage ids that actually belong to that other execution's work.
      for (const sid of stages) {
        if (executionStageIds && executionStageIds.has(sid)) stageIdSet.add(sid);
      }
    }
    return stageIdSet.size > 0 ? { metrics, stageIds: [...stageIdSet].sort((a, b) => a - b) } : { metrics };
  }

  function makeNode(info: SparkPlanInfo, children: PlanNode[]): PlanNode {
    const { metrics, stageIds } = computeMetricsAndStageIds(info);
    const node: PlanNode = { id: `${idPrefix}n${nextId++}`, name: info.nodeName, detail: info.simpleString ?? '', metrics, children };
    if (stageIds) node.stageIds = stageIds;
    return node;
  }

  // Only a node whose raw name is exactly Exchange/BroadcastExchange gets
  // split; ReusedExchange and any other exchange-family variant stay a
  // single node (confirmed against real event logs: ReusedExchange carries
  // no metrics of its own, it references an already-materialized Exchange
  // elsewhere). Runs on the raw name because no PlanNode/exchangeRole
  // exists yet at this point in construction.
  function makeExchangeSplit(info: SparkPlanInfo, children: PlanNode[]): PlanNode {
    const { metrics, stageIds } = computeMetricsAndStageIds(info);
    // write = producer side: keeps the real metrics (e.g. "data size", the
    // shuffle write metrics) and the original children.
    const write: PlanNode = {
      id: `${idPrefix}n${nextId++}`,
      name: info.nodeName,
      detail: '',
      metrics,
      children,
      exchangeRole: 'write',
    };
    if (stageIds) write.stageIds = stageIds;
    // read = consumer side: keeps the original detail (plan-summary.ts's
    // partitioning-key regex needs it), no metrics of its own.
    const read: PlanNode = {
      id: `${idPrefix}n${nextId++}`,
      name: info.nodeName,
      detail: info.simpleString ?? '',
      metrics: [],
      children: [write],
      exchangeRole: 'read',
    };
    if (stageIds) read.stageIds = stageIds;
    return read;
  }

  const stack: SparkPlanInfo[] = [rootInfo];
  const order: SparkPlanInfo[] = [];

  while (stack.length > 0) {
    const info = stack.pop()!;
    if (seen.has(info)) continue;
    seen.add(info);
    order.push(info);
    for (const child of (info.children ?? [])) {
      if (!seen.has(child)) stack.push(child);
    }
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const info = order[i];
    const children: PlanNode[] = [];
    for (const child of (info.children ?? [])) {
      const childNode = nodeMap.get(child);
      if (childNode) children.push(childNode);
    }
    const node = info.nodeName === 'Exchange' || info.nodeName === 'BroadcastExchange'
      ? makeExchangeSplit(info, children)
      : makeNode(info, children);
    nodeMap.set(info, node);
  }

  return nodeMap.get(rootInfo)!;
}

// Maps SparkListenerStageExecutorMetrics' "Executor Metrics" field names to our camelCase names.
// Only listed fields are captured (forward-compat with future Spark ExecutorMetricType additions).
const EXECUTOR_METRIC_FIELD_MAP: Record<string, string> = {
  JVMHeapMemory: 'jvmHeapMemory', JVMOffHeapMemory: 'jvmOffHeapMemory',
  OnHeapExecutionMemory: 'onHeapExecutionMemory', OffHeapExecutionMemory: 'offHeapExecutionMemory',
  OnHeapStorageMemory: 'onHeapStorageMemory', OffHeapStorageMemory: 'offHeapStorageMemory',
  OnHeapUnifiedMemory: 'onHeapUnifiedMemory', OffHeapUnifiedMemory: 'offHeapUnifiedMemory',
  DirectPoolMemory: 'directPoolMemory', MappedPoolMemory: 'mappedPoolMemory',
  ProcessTreeJVMVMemory: 'processTreeJVMVMemory', ProcessTreeJVMRSSMemory: 'processTreeJVMRSSMemory',
  ProcessTreePythonVMemory: 'processTreePythonVMemory', ProcessTreePythonRSSMemory: 'processTreePythonRSSMemory',
  ProcessTreeOtherVMemory: 'processTreeOtherVMemory', ProcessTreeOtherRSSMemory: 'processTreeOtherRSSMemory',
  MinorGCCount: 'minorGCCount', MinorGCTime: 'minorGCTime',
  MajorGCCount: 'majorGCCount', MajorGCTime: 'majorGCTime', TotalGCTime: 'totalGCTime',
  ConcurrentGCCount: 'concurrentGCCount', ConcurrentGCTime: 'concurrentGCTime',
};

export function startApplication(event: z.infer<typeof ApplicationStartEventSchema>, state: ParserState) {
  const config = state.pendingConfig ?? {};
  state.app = {
    id: event['App ID'],
    name: event['App Name'],
    startTime: event['Timestamp'],
    endTime: null,
    sparkVersion: state.pendingSparkVersion ?? event['Spark Version'] ?? null,
    config,
    resources: state.pendingResources ?? extractResources(config),
    rddInfo: state.rddInfo,
  };
  return appMessage(state);
}

export function updateEnvironment(event: z.infer<typeof EnvironmentUpdateEventSchema>, state: ParserState) {
  state.evidenceInputs.environmentUpdates++;
  const config = normalizeSparkProperties(event['Spark Properties']);
  const resources = extractResources(config);
  // EnvironmentUpdate normally precedes ApplicationStart: stash the config so ApplicationStart can
  // attach it. If it arrives after (a mid-run update), apply live and re-post the app.
  if (state.app) {
    state.app.config = config;
    state.app.resources = resources;
    return appMessage(state);
  }
  state.pendingConfig = config;
  state.pendingResources = resources;
  return null;
}

export function startJob(event: z.infer<typeof JobStartEventSchema>, state: ParserState): null {
  const stageIds = event['Stage IDs'] ?? [];
  const sqlExecIdStr = event['Properties']?.['spark.sql.execution.id'];
  const sqlExecutionId = sqlExecIdStr != null ? parseInt(String(sqlExecIdStr), 10) : null;
  if (sqlExecutionId != null) {
    if (!state.sqlExecStages.has(sqlExecutionId)) state.sqlExecStages.set(sqlExecutionId, new Set());
    const stageSet = state.sqlExecStages.get(sqlExecutionId)!;
    for (const stageId of stageIds) {
      state.stageToSqlExec.set(stageId, sqlExecutionId);
      stageSet.add(stageId);
    }
  }
  const jobId = event['Job ID'];
  if (jobId != null) {
    state.jobs.set(jobId, {
      id: jobId,
      submissionTime: event['Submission Time'] ?? null,
      stageIds,
      sqlExecutionId,
      result: null, succeeded: null, exception: null, completionTime: null,
    });
  }
  return null;
}

export function endJob(event: z.infer<typeof JobEndEventSchema>, state: ParserState): { type: 'job'; data: Job } {
  const jobId = event['Job ID'];
  const result = event['Job Result']?.['Result'] ?? null;
  const exception = event['Job Result']?.['Exception']?.['Message'] ?? null;
  const job: Job = state.jobs.get(jobId) ?? {
    id: jobId, submissionTime: null, stageIds: [], sqlExecutionId: null,
    result: null, succeeded: null, exception: null, completionTime: null,
  };
  job.result = result;
  job.succeeded = result === 'JobSucceeded';
  job.exception = exception;
  job.completionTime = event['Completion Time'] ?? null;
  state.jobs.set(jobId, job);
  return { type: 'job', data: { ...job } };
}

export function submitStage(event: z.infer<typeof StageSubmittedEventSchema>, state: ParserState): null {
  state.evidenceInputs.stageSubmissions++;
  const info = event['Stage Info'];
  const id = info['Stage ID'];
  state.stages.set(id, {
    id, name: info['Stage Name'] ?? '', details: info['Details'] ?? '',
    submittedAt: info['Submission Time'] ?? 0, completedAt: 0,
    taskCount: 0, failedTasks: 0,
    shuffleReadBytes: 0, shuffleWriteBytes: 0, fetchWaitTime: 0,
    memoryBytesSpilled: 0, diskBytesSpilled: 0,
    jvmGCTime: 0, executorRunTime: 0, executorCpuTime: 0,
    inputBytes: 0, outputBytes: 0,
    sqlExecutionId: state.stageToSqlExec.get(id) ?? null,
    parentIds: info['Parent IDs'] ?? [],
    hostStats: new Map(),
    speculativeTasks: 0,
    failureReasons: new Map(),
    stageFailureReason: null,
    taskAttempts: new Map(),
    retryTaskSamples: [],
    retryWasteMs: 0,
    wastedAttempts: 0,
    speculationWasteMs: 0,
    speculationWastedAttempts: 0,
    executorMetrics: new Map(),
  });
  mergeStageRddInfo(info, id, state);
  return null;
}

export function mergeStageRddInfo(
  info: z.infer<typeof StageSubmittedEventSchema>['Stage Info'],
  id: number,
  state: ParserState
): void {
  for (const rdd of (info['RDD Info'] ?? [])) {
    const rddId = rdd['RDD ID'];
    if (rddId == null) continue;
    state.evidenceInputs.rddStorageSnapshots++;
    const sl = rdd['Storage Level'] ?? {};
    const prev = state.rddInfo.get(rddId);
    const stageIds = prev?.stageIds ?? new Set<number>();
    stageIds.add(id);
    state.rddInfo.set(rddId, {
      id: rddId,
      name: rdd['Name'] ?? '',
      callsite: rdd['Callsite'] ?? '',
      storageLevel: {
        useDisk: sl['Use Disk'] ?? false,
        useMemory: sl['Use Memory'] ?? false,
        deserialized: sl['Deserialized'] ?? false,
        replication: sl['Replication'] ?? 1,
      },
      numPartitions: rdd['Number of Partitions'] ?? 0,
      // Merge forward, don't overwrite: an RDD cached for the first time in THIS stage legitimately
      // reports 0 (snapshot reflects BlockManager state at submission). Keep the last real value on
      // a resubmission instead of regressing to 0.
      numCachedPartitions: rdd['Number of Cached Partitions'] || prev?.numCachedPartitions || 0,
      memorySize: rdd['Memory Size'] || prev?.memorySize || 0,
      diskSize: rdd['Disk Size'] || prev?.diskSize || 0,
      stageIds,
    });
  }
}

// Spark logs these AFTER SparkListenerStageCompleted, so finalizeStage has already posted the
// stage with an empty executorMetrics Map. Keep accumulating worker-side, then re-post all maps
// once via `stageExecutorMetrics` just before `done` so main-thread stages are patched before analyze().
export function recordStageExecutorMetrics(event: z.infer<typeof StageExecutorMetricsEventSchema>, state: ParserState): null {
  const stage = state.stages.get(event['Stage ID']);
  if (!stage) return null;
  const raw = event['Executor Metrics'] ?? {};
  const metrics: Record<string, number> = {};
  for (const [sparkName, ourName] of Object.entries(EXECUTOR_METRIC_FIELD_MAP)) {
    if (raw[sparkName] != null) metrics[ourName] = raw[sparkName];
  }
  if (Object.keys(metrics).length > 0) {
    state.evidenceInputs.executorMetricRows++;
  }
  stage.executorMetrics.set(event['Executor ID'], metrics);
  return null;
}

export function startSqlExecution(event: z.infer<typeof SqlExecutionStartEventSchema>, state: ParserState): { type: 'sql'; data: SqlExecutionRecord } {
  state.evidenceInputs.sqlExecutions++;
  const sparkPlanInfo = event.sparkPlanInfo ?? null;
  const exec: SqlExecutionRecord = {
    id: event.executionId, description: event.description ?? '',
    startTime: event.time, endTime: null, stageIds: [],
    sparkPlanInfo,
    hadAdaptiveUpdate: false,
  };
  state.sqlExecutions.set(exec.id, exec);
  if (sparkPlanInfo !== null) {
    state.accumState.set(exec.id, new Map());
  }
  return { type: 'sql', data: exec };
}

export function endSqlExecution(
  event: z.infer<typeof SqlExecutionEndEventSchema>,
  state: ParserState
): { type: 'sql'; data: SqlExecutionRecord } | { type: 'sqlPlan'; data: { executionId: number; planTree: PlanNode } } | null {
  const exec = state.sqlExecutions.get(event.executionId);
  if (exec) exec.endTime = event.time;

  const planInfo = exec?.sparkPlanInfo ?? null;
  if (!planInfo || !planInfo.nodeName) {
    state.accumState.delete(event.executionId);
    return exec ? { type: 'sql', data: { ...exec } } : null;
  }

  const accumMap = state.accumState.get(event.executionId) ?? new Map<number, number>();
  const planTree = resolvePlanTree(
    planInfo, accumMap, state.taskAccumStages, state.sqlExecStages.get(event.executionId), event.executionId,
  );
  state.accumState.delete(event.executionId);
  // The resolved tree is all anything downstream reads; the raw plan (often megabytes per
  // execution under AQE) would otherwise stay live for the rest of the parse.
  exec!.sparkPlanInfo = null;

  state.evidenceInputs.resolvedSqlPlans++;
  return { type: 'sqlPlan', data: { executionId: event.executionId, planTree } };
}

export function applyDriverAccumUpdates(event: z.infer<typeof DriverAccumUpdatesEventSchema>, state: ParserState): null {
  const { executionId, accumUpdates } = event;
  if (!state.accumState.has(executionId)) return null; // late update, discard
  const map = state.accumState.get(executionId)!;
  for (const [accId, delta] of accumUpdates) {
    map.set(accId, (map.get(accId) ?? 0) + delta);
  }
  return null;
}

export function applyAdaptiveExecutionUpdate(
  event: z.infer<typeof SqlAdaptiveExecutionUpdateEventSchema>,
  state: ParserState,
): { type: 'sql'; data: SqlExecutionRecord } | null {
  const exec = state.sqlExecutions.get(event.executionId);
  if (!exec) return null; // late update for an unseen execution, discard (same pattern as applyDriverAccumUpdates)
  if (event.sparkPlanInfo != null) exec.sparkPlanInfo = event.sparkPlanInfo;
  exec.hadAdaptiveUpdate = true;
  // Re-emit a 'sql' message so the browser's structured-cloned appModel.sql copy sees the flip:
  // otherwise hadAdaptiveUpdate only reads true via collectRun's Node-path object aliasing, never
  // in the shipping worker. Shallow copy so the posted object isn't the mutable reference the worker keeps mutating.
  // The raw plan stays worker-side: the main thread only ever reads the resolved `sqlPlan` tree,
  // and a copy here would keep a superseded plan alive after endSqlExecution releases it.
  return { type: 'sql', data: { ...exec, sparkPlanInfo: null } };
}

export function addExecutor(event: z.infer<typeof ExecutorAddedEventSchema>, state: ParserState): { type: 'executor'; data: ExecutorAddedEvent } {
  const ev: ExecutorAddedEvent = {
    kind: 'added', timestamp: event['Timestamp'],
    executorId: event['Executor ID'],
    host: event['Executor Info']?.['Host'] ?? '',
    totalCores: event['Executor Info']?.['Total Cores'] ?? 0,
    // Resource Profile Id lives inside Executor Info in real Spark logs;
    // fall back to a top-level key for any variant that hoists it.
    resourceProfileId: event['Executor Info']?.['Resource Profile Id'] ?? event['Resource Profile Id'] ?? null,
  };
  state.executors.added.push(ev);
  return { type: 'executor', data: ev };
}

export function removeExecutor(event: z.infer<typeof ExecutorRemovedEventSchema>, state: ParserState): { type: 'executor'; data: ExecutorRemovedEvent } {
  const ev: ExecutorRemovedEvent = {
    kind: 'removed', timestamp: event['Timestamp'],
    executorId: event['Executor ID'],
    reason: event['Removed Reason'] ?? '',
  };
  state.executors.removed.push(ev);
  return { type: 'executor', data: ev };
}

export function processEvent(event: SparkEvent, state: ParserState): unknown {
  switch (event.Event) {
    case 'SparkListenerLogStart':
      state.pendingSparkVersion = event['Spark Version'] ?? null;
      return null;

    case 'SparkListenerApplicationStart':
      return startApplication(event, state);

    case 'SparkListenerEnvironmentUpdate':
      return updateEnvironment(event, state);

    case 'SparkListenerApplicationEnd':
      state.evidenceInputs.applicationEnds++;
      if (state.app) {
        state.app.endTime = event['Timestamp'];
        return appMessage(state);
      }
      return null;

    case 'SparkListenerJobStart':
      return startJob(event, state);

    case 'SparkListenerJobEnd':
      return endJob(event, state);

    case 'SparkListenerStageSubmitted':
      return submitStage(event, state);

    case 'SparkListenerStageCompleted': {
      const info = event['Stage Info'];
      const id = info['Stage ID'];
      const stage = state.stages.get(id);
      if (!stage) return null;
      stage.completedAt = info['Completion Time'] ?? 0;
      // Older Spark (seen on 1.x-2.0 logs) posts StageSubmitted before the stage's submission
      // time is set; StageCompleted carries it. Without this backfill submittedAt stays 0 and
      // every stage-duration figure becomes the epoch timestamp itself (a "47-year" stage).
      if (!stage.submittedAt && info['Submission Time'] != null) stage.submittedAt = info['Submission Time'];
      stage.stageFailureReason = info['Failure Reason'] ?? null;
      // finalizeStage keeps its `stage` parameter typed as a loose Record (see that module); bridge
      // StageRecord's more precise shape across that boundary with an explicit cast.
      return finalizeStage(
        id,
        stage as unknown as Record<string, unknown> & { taskAttempts: Map<unknown, Record<string, number>> | null },
        state
      );
    }

    case 'SparkListenerStageExecutorMetrics':
      return recordStageExecutorMetrics(event, state);

    case 'SparkListenerTaskEnd':
      return accumulateTask(event, state);

    case 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart':
      return startSqlExecution(event, state);

    case 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate':
      return applyAdaptiveExecutionUpdate(event, state);

    case 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd':
      return endSqlExecution(event, state);

    case 'org.apache.spark.sql.execution.ui.SparkListenerDriverAccumUpdates':
      return applyDriverAccumUpdates(event, state);

    case 'SparkListenerExecutorAdded':
      return addExecutor(event, state);

    case 'SparkListenerExecutorRemoved':
      return removeExecutor(event, state);

    default:
      return assertNever(event);
  }
}

// Derived from SparkEventSchema itself, so this set can never drift from the union's literal list.
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  SparkEventSchema.options.map((option) => option.shape.Event.value)
);

// SQLExecutionStart and SQLAdaptiveExecutionUpdate carry `physicalPlanDescription`, Spark's text
// rendering of the plan. Nothing reads it (the plan tree comes from sparkPlanInfo), yet on a real
// 3.5 GB log it was 72% of the AQE-update bytes, which were themselves 73% of the log. Cutting its
// string value out before JSON.parse halves the parse cost of those lines.
const SQL_UI_EVENT_PREFIX = '{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQL';
const PLAN_DESCRIPTION_KEY = '"physicalPlanDescription":"';

// Returns `line` with the physicalPlanDescription string value emptied, or `line` unchanged when
// the key isn't found in Spark's compact form. The key pattern can't match inside another JSON
// string: there its quotes would be backslash-escaped.
export function stripPlanDescription(line: string): string {
  if (!line.startsWith(SQL_UI_EVENT_PREFIX)) return line;
  const keyAt = line.indexOf(PLAN_DESCRIPTION_KEY);
  if (keyAt === -1) return line;
  const valueStart = keyAt + PLAN_DESCRIPTION_KEY.length;
  // The closing quote is the first one preceded by an even number of backslashes.
  let quote = line.indexOf('"', valueStart);
  while (quote !== -1) {
    let backslashes = 0;
    for (let i = quote - 1; i >= valueStart && line.charCodeAt(i) === 0x5c; i--) backslashes++;
    if (backslashes % 2 === 0) break;
    quote = line.indexOf('"', quote + 1);
  }
  // Unterminated string (a truncated line): leave it for JSON.parse to reject.
  if (quote === -1) return line;
  return line.slice(0, valueStart) + line.slice(quote);
}

export function dispatchLine(line: string, state: ParserState, emit: (msg: unknown) => void): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripPlanDescription(line));
  } catch {
    state.skippedLines++;
    return;
  }
  // A real Spark event log carries many event types this tool never modeled (BlockManagerAdded,
  // TaskStart, ...): an `Event` outside our modeled literals is silently ignored, never counted as
  // a skipped line. Only a KNOWN type that fails ITS schema is a genuine signal worth surfacing.
  const eventType = (parsed as { Event?: unknown } | null)?.Event;
  if (typeof eventType !== 'string' || !KNOWN_EVENT_TYPES.has(eventType)) {
    return;
  }
  const result = SparkEventSchema.safeParse(parsed);
  if (!result.success) {
    state.skippedLines++;
    return;
  }
  let msg: unknown;
  try {
    msg = processEvent(result.data, state);
  } catch (err) {
    // processEvent's switch is exhaustive over the schema-validated union (assertNever default), so
    // this is unreachable for any event that got this far. If it fires it's a handler bug, not
    // malformed input; log it distinctly so it doesn't masquerade as an ordinary skipped-line count.
    console.error('processEvent threw for an already-validated event:', err);
    state.skippedLines++;
    return;
  }
  if (msg) emit(msg);
}

// Gather every stage's post-completion-populated executorMetrics for a single re-post just before
// `done` (the per-stage message posted at completion is empty). Empty when the log had no
// spark.eventLog.logStageExecutorMetrics data.
export function collectStageExecutorMetrics(state: ParserState): Map<number, Map<string, Record<string, number>>> {
  const out = new Map<number, Map<string, Record<string, number>>>();
  for (const [id, stage] of state.stages) {
    if (stage.executorMetrics instanceof Map && stage.executorMetrics.size > 0) {
      out.set(id, stage.executorMetrics);
    }
  }
  return out;
}

export function emitParseCompletion(state: ParserState, emit: (msg: unknown) => void, linesProcessed: number): void {
  emit({ type: 'progress', pct: 1, linesProcessed });
  emit({ type: 'runAggregates', data: computeRunAggregates(state.taskStore) });
  emit({ type: 'stageExecutorMetrics', data: collectStageExecutorMetrics(state) });
  emit(appMessage(state));
  emit({ type: 'done', skippedLines: state.skippedLines });
  state.accumState.clear();
}
