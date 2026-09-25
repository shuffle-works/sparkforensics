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
  BlockUpdatedEventSchema,
  type SparkEvent,
  type SparkPlanInfo,
} from './event-schemas.ts';
import { assertNever } from './assert-never.ts';
import { finalizeStage } from './stage-quantiles.ts';
import { MAX_FAILURE_DETAILS_PER_STAGE, extractTaskFailureDetail, taskFailureKey, type TaskFailureDetail } from './task-failure.ts';
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
  // Where numCachedPartitions/memorySize/diskSize came from: 'rddInfo' is StageSubmitted's RDD Info
  // snapshot (always 0 since Spark 2.3, real only on Spark 1.x logs); 'blockUpdates' is the
  // per-block SparkListenerBlockUpdated stream (spark.eventLog.logBlockUpdates.enabled=true).
  storageSource: 'rddInfo' | 'blockUpdates';
  stageIds: Set<number>;
}

// Live per-RDD block residency rebuilt from SparkListenerBlockUpdated. Keyed by partition and
// executor because a block's status is per BlockManager: replicas and re-caches on another
// executor are separate entries, as in Spark's own AppStatusListener.
interface RddBlockState {
  blocks: Map<string, { partition: number; memorySize: number; diskSize: number }>;
  replicasByPartition: Map<number, number>;
  memorySize: number;
  diskSize: number;
  peakCachedPartitions: number;
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
  // Failed attempts only: shared with every other attempt that failed the same way (see
  // internTaskFailure), null past the per-stage distinct-failure cap.
  failure: TaskFailureDetail | null;
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
  // Distinct failures seen so far, by taskFailureKey; freed with taskAttempts at finalize.
  failureDetails: Map<string, TaskFailureDetail> | null;
  retryTaskSamples: FailedTaskSample[];
  retryWasteMs: number;
  wastedAttempts: number;
  speculationWasteMs: number;
  speculationWastedAttempts: number;
  // Keys (`attempt:index`) whose recorded winner is a speculative copy. Kept past finalize so a
  // late TaskEnd for the original it beat still pairs as speculation waste (accountLateSpeculativeLoser).
  speculativeWinners: Set<string | symbol>;
  // Set once a late TaskEnd adds speculation waste after finalize, so the stage is re-posted
  // via `stageSpeculationWaste` before `done`.
  lateSpeculationWaste: boolean;
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
  rddBlocks: Map<number, RddBlockState>;
  // SparkListenerBlockUpdated events for rdd_* blocks. Zero means the log carries no block-level
  // cache evidence (logBlockUpdates off, or nothing was ever cached).
  rddBlockUpdates: number;
  taskAccumStages: Map<number, Set<number>>;
  evidenceInputs: EvidenceInputs;
  // An open SQL execution's latest AQE update, as raw line text, not yet parsed (see
  // deferAdaptiveUpdate). Applied when the execution ends, or at parse completion.
  pendingAdaptiveUpdates: Map<number, string>;
  // SQL executions whose plan tree endSqlExecution already resolved and posted.
  resolvedPlanExecutions: Set<number>;
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
//
// A SQL UI event's physicalPlanDescription value (see stripPlanDescription) that is still open
// when a chunk ends is cut off the pending line, and the following bytes are dropped up to its
// closing quote without being decoded. On the largest real log that value is 1.9 GB of the
// 3.5 GB stream, so it is never decoded, joined or scanned as text. A chunk longer than
// MAX_DECODE_SLICE is decoded in slices of that size, so the skip also applies within one chunk:
// Node's native zstd emits whole frames, up to 39 MB on that log, which held all but 51 MB of the
// value inside a single chunk.
const MAX_DECODE_SLICE = 512 * 1024;

// A line joined from text decoded in more than one slice is a V8 cons string, which the first
// character read (startsWith, charCodeAt, endsWith) copies into one flat string. `head` and `tail`
// are its flat first and last pieces, so dispatchLine can check a prefix or suffix without that
// copy. `index` is the line's position in the array decode() returned.
export interface JoinedLine {
  index: number;
  head: string;
  tail: string;
}

export function buildChunkDecoder() {
  const decoder = new TextDecoder('utf-8');
  // Decoded partial line after the last newline, carried to the next chunk, and its flat first
  // piece (pending itself until later text is appended to it).
  let pending = '';
  let pendingHead = '';
  // True once the pending line is known to need no plan-description skip.
  let pendingSettled = false;
  // While it isn't, how far its plan-key search got, so each slice searches only its own text:
  // whether the line starts with the SQL UI event prefix, and the end of the text already searched
  // (one char short of the key, so a key split across slices still matches). Searching the whole
  // line again after every slice scanned about 10 GB on a 100 MB line.
  let pendingIsSqlEvent = false;
  let keyTail = '';
  let skippingPlanDescription = false;
  // Length of the backslash run the skipped bytes ended with, which escapes a quote at the start
  // of the next chunk when odd.
  let carriedBackslashes = 0;

  // Where the plan key starts in `pending`, searching only `appended` (the text just added to its
  // end) and the seam before it, or -1.
  function findPlanKey(appended: string): number {
    const seamLength = PLAN_DESCRIPTION_KEY.length - 1;
    const before = pending.length - appended.length;
    if (keyTail !== '') {
      const inSeam = (keyTail + appended.slice(0, seamLength)).indexOf(PLAN_DESCRIPTION_KEY);
      if (inSeam !== -1) return before - keyTail.length + inSeam;
    }
    const inText = appended.indexOf(PLAN_DESCRIPTION_KEY);
    if (inText !== -1) return before + inText;
    keyTail = appended.length >= seamLength ? appended.slice(-seamLength) : (keyTail + appended).slice(-seamLength);
    return -1;
  }

  function settlePending(lastByte: number, appended: string): void {
    if (!pendingIsSqlEvent) {
      if (pending.length < SQL_UI_EVENT_PREFIX.length) {
        pendingSettled = !SQL_UI_EVENT_PREFIX.startsWith(pending);
        return;
      }
      // The flat first piece, when it is long enough: startsWith on the joined line would copy it.
      const head = pendingHead.length >= SQL_UI_EVENT_PREFIX.length ? pendingHead : pending;
      if (!head.startsWith(SQL_UI_EVENT_PREFIX)) { pendingSettled = true; return; }
      pendingIsSqlEvent = true;
      keyTail = '';
      appended = pending; // nothing of it was searched while it was shorter than the prefix
    }
    const keyAt = findPlanKey(appended);
    if (keyAt === -1) return; // the key may still arrive in a later chunk
    pendingSettled = true;
    const valueStart = keyAt + PLAN_DESCRIPTION_KEY.length;
    if (closingQuoteIndex(pending, valueStart) !== -1) return; // complete: stripPlanDescription empties it
    // Only a chunk whose last byte is a backslash carries a run over; any other last byte (such
    // as part of a split multibyte char) ends it.
    let run = 0;
    if (lastByte === BACKSLASH) {
      for (let i = pending.length - 1; i >= valueStart && pending.charCodeAt(i) === BACKSLASH; i--) run++;
    }
    carriedBackslashes = run;
    pending = pending.substring(0, valueStart);
    pendingHead = pending;
    decoder.decode(); // discard a split multibyte char held from the dropped value
    skippingPlanDescription = true;
  }

  function decodeSlice(buffer: Uint8Array, lines: string[], joined: JoinedLine[] | undefined): void {
    let from = 0;
    if (skippingPlanDescription) {
      const lineEnd = buffer.indexOf(NEWLINE);
      const close = closingQuoteAt(buffer, lineEnd === -1 ? buffer.length : lineEnd, carriedBackslashes);
      if (close === -1 && lineEnd === -1) {
        let i = buffer.length - 1;
        while (i >= 0 && buffer[i] === BACKSLASH) i--;
        carriedBackslashes = buffer.length - 1 - i + (i < 0 ? carriedBackslashes : 0);
        return;
      }
      // Resume at the closing quote, or at the newline of an unterminated value: that line then
      // ends in an open string and JSON.parse rejects it, as it would have the whole line.
      skippingPlanDescription = false;
      from = close !== -1 ? close : lineEnd;
    }
    const text = decoder.decode(from === 0 ? buffer : buffer.subarray(from), { stream: true });
    let nl = text.indexOf('\n');
    // The text this slice added to the end of `pending`.
    let appended = text;
    if (nl === -1) {
      if (pending === '') {
        pending = pendingHead = text;
        pendingIsSqlEvent = false;
      } else {
        pending = pending + text;
      }
    } else {
      // Zero-length lines are dropped to match a `.filter(l => l.length)`.
      let first: string;
      if (pending === '') {
        first = text.substring(0, nl);
      } else {
        const tail = text.substring(0, nl);
        first = pending + tail;
        joined?.push({ index: lines.length, head: pendingHead, tail });
      }
      if (first.length > 0) lines.push(first);
      let start = nl + 1;
      nl = text.indexOf('\n', start);
      while (nl !== -1) {
        if (nl > start) lines.push(text.substring(start, nl));
        start = nl + 1;
        nl = text.indexOf('\n', start);
      }
      pending = pendingHead = appended = start < text.length ? text.substring(start) : '';
      pendingSettled = false;
      pendingIsSqlEvent = false;
    }
    if (!pendingSettled && pending !== '') settlePending(buffer[buffer.length - 1], appended);
  }

  return {
    // `joined`, when given, receives a JoinedLine for each returned line that was joined across
    // slices, in line order.
    decode(buffer: Uint8Array, joined?: JoinedLine[]): string[] {
      const lines: string[] = [];
      if (buffer.length <= MAX_DECODE_SLICE) decodeSlice(buffer, lines, joined);
      else for (let at = 0; at < buffer.length; at += MAX_DECODE_SLICE) decodeSlice(buffer.subarray(at, at + MAX_DECODE_SLICE), lines, joined);
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
    rddBlocks: new Map(),
    rddBlockUpdates: 0,
    taskAccumStages: new Map(),
    pendingAdaptiveUpdates: new Map(),
    resolvedPlanExecutions: new Set(),
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
  state.app!.rddBlockUpdates = state.rddBlockUpdates;
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

// One shared detail object per distinct failure, so a stage with thousands of failed attempts
// holds each bounded stack excerpt once. Past the cap an attempt keeps only its reason tag.
function internTaskFailure(stage: StageRecord, endReason: Record<string, unknown> | undefined): TaskFailureDetail | null {
  const detail = extractTaskFailureDetail(endReason);
  if (!detail || !stage.failureDetails) return null;
  const key = taskFailureKey(detail);
  const known = stage.failureDetails.get(key);
  if (known) return known;
  if (stage.failureDetails.size >= MAX_FAILURE_DETAILS_PER_STAGE) return null;
  stage.failureDetails.set(key, detail);
  return detail;
}

export function accumulateTask(event: z.infer<typeof TaskEndEventSchema>, state: ParserState): null {
  const stageId = event['Stage ID'];
  const stage = state.stages.get(stageId);
  if (!stage) return null;
  // Late TaskEnd for a stage whose StageCompleted already freed taskAttempts (finalizeStage): its
  // stats are already baked into the finalized stage, don't re-add. The one exception is a losing
  // speculative attempt, whose wasted time the finalized stage never saw.
  if (stage.taskAttempts === null) {
    accountLateSpeculativeLoser(event, stage);
    return null;
  }

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
    failure: failed ? internTaskFailure(stage, event['Task End Reason']) : null,
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
    if (record.speculative && !record.failed) stage.speculativeWinners.add(key);
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
    if (record.speculative) stage.speculativeWinners.add(key);
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

// Spark kills the losing copy of a speculative race only once the stage finishes ("Stage
// cancelled: Stage finished"), so that loser's TaskEnd normally lands after StageCompleted. Count
// its time as speculation waste, pairing it the same way accumulateTask does: the late attempt is
// the speculative copy itself, or the original that a speculative winner beat. Every other stat
// of a late attempt stays excluded, as the finalized stage already posted them.
function accountLateSpeculativeLoser(event: z.infer<typeof TaskEndEventSchema>, stage: StageRecord): void {
  const info = event['Task Info'];
  if (info?.['Index'] == null) return;
  const key = `${event['Stage Attempt ID'] ?? 0}:${info['Index']}`;
  if (info['Speculative'] !== true && !stage.speculativeWinners.has(key)) return;
  stage.speculationWasteMs += (info['Finish Time'] ?? 0) - (info['Launch Time'] ?? 0);
  stage.speculationWastedAttempts++;
  stage.lateSpeculationWaste = true;
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
    failureDetails: new Map(),
    retryTaskSamples: [],
    retryWasteMs: 0,
    wastedAttempts: 0,
    speculationWasteMs: 0,
    speculationWastedAttempts: 0,
    speculativeWinners: new Set(),
    lateSpeculationWaste: false,
    executorMetrics: new Map(),
  });
  mergeStageRddInfo(info, id, state);
  return null;
}

// countSnapshots is false for StageCompleted: the evidence ledger's rddStorageSnapshots counts
// stage-submission snapshots only.
export function mergeStageRddInfo(
  info: Pick<z.infer<typeof StageSubmittedEventSchema>['Stage Info'], 'RDD Info'>,
  id: number,
  state: ParserState,
  countSnapshots = true,
): void {
  for (const rdd of (info['RDD Info'] ?? [])) {
    const rddId = rdd['RDD ID'];
    if (rddId == null) continue;
    if (countSnapshots) state.evidenceInputs.rddStorageSnapshots++;
    const sl = rdd['Storage Level'] ?? {};
    const prev = state.rddInfo.get(rddId);
    const stageIds = prev?.stageIds ?? new Set<number>();
    stageIds.add(id);
    // Block updates are the authoritative source once seen: never let a later RDD Info snapshot
    // (0 on Spark 2.3+) replace them.
    const fromBlocks = prev?.storageSource === 'blockUpdates';
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
      numCachedPartitions: fromBlocks ? prev.numCachedPartitions : rdd['Number of Cached Partitions'] || prev?.numCachedPartitions || 0,
      memorySize: fromBlocks ? prev.memorySize : rdd['Memory Size'] || prev?.memorySize || 0,
      diskSize: fromBlocks ? prev.diskSize : rdd['Disk Size'] || prev?.diskSize || 0,
      storageSource: prev?.storageSource ?? 'rddInfo',
      stageIds,
    });
  }
}

const RDD_BLOCK_ID = /^rdd_(\d+)_(\d+)$/;

/**
 * Folds one SparkListenerBlockUpdated into its RDD's live residency, then publishes the RDD's
 * peak state to rddInfo: the most partitions resident at once, with the memory/disk bytes at the
 * latest moment that peak held. A peak rather than the final state, because an unpersist() (or
 * the app's own cleanup) removes every block before the log ends, and a final snapshot would
 * read as "nothing was cached". Ties refresh, so a partition dropping from memory to disk after
 * the peak still shows up in diskSize. Non-RDD blocks (broadcast, shuffle, task results) are ignored.
 */
export function recordBlockUpdate(event: z.infer<typeof BlockUpdatedEventSchema>, state: ParserState): null {
  const info = event['Block Updated Info'];
  const match = RDD_BLOCK_ID.exec(info['Block ID']);
  if (!match) return null;
  state.rddBlockUpdates++;
  const rddId = Number(match[1]);
  const partition = Number(match[2]);
  const sl = info['Storage Level'] ?? {};
  // Spark's StorageLevel.isValid: a removal or eviction reports level NONE.
  const resident = Boolean(sl['Use Memory'] || sl['Use Disk']) && (sl['Replication'] ?? 1) > 0;

  let rdd = state.rddBlocks.get(rddId);
  if (!rdd) {
    rdd = { blocks: new Map(), replicasByPartition: new Map(), memorySize: 0, diskSize: 0, peakCachedPartitions: 0 };
    state.rddBlocks.set(rddId, rdd);
  }
  const key = `${partition}@${info['Block Manager ID']?.['Executor ID'] ?? ''}`;
  const prev = rdd.blocks.get(key);
  if (prev) {
    rdd.memorySize -= prev.memorySize;
    rdd.diskSize -= prev.diskSize;
    const replicas = (rdd.replicasByPartition.get(partition) ?? 1) - 1;
    if (replicas > 0) rdd.replicasByPartition.set(partition, replicas);
    else rdd.replicasByPartition.delete(partition);
    rdd.blocks.delete(key);
  }
  if (resident) {
    // Sizes count only where the level says the block lives, as Spark's AppStatusListener does: a
    // drop from memory to disk reports Use Memory false but still carries the dropped bytes as
    // Memory Size (BlockManager reports max(memSize, droppedMemorySize)).
    const block = {
      partition,
      memorySize: sl['Use Memory'] ? info['Memory Size'] ?? 0 : 0,
      diskSize: sl['Use Disk'] ? info['Disk Size'] ?? 0 : 0,
    };
    rdd.blocks.set(key, block);
    rdd.memorySize += block.memorySize;
    rdd.diskSize += block.diskSize;
    rdd.replicasByPartition.set(partition, (rdd.replicasByPartition.get(partition) ?? 0) + 1);
  }

  const record = state.rddInfo.get(rddId) ?? {
    // A block reported before any stage listed its RDD: name and partition count arrive with
    // the next StageSubmitted (mergeStageRddInfo keeps the block-derived sizes).
    id: rddId, name: '', callsite: '',
    storageLevel: { useDisk: Boolean(sl['Use Disk']), useMemory: Boolean(sl['Use Memory']), deserialized: false, replication: sl['Replication'] ?? 1 },
    numPartitions: 0, numCachedPartitions: 0, memorySize: 0, diskSize: 0,
    storageSource: 'blockUpdates' as const, stageIds: new Set<number>(),
  };
  record.storageSource = 'blockUpdates';
  if (rdd.replicasByPartition.size >= rdd.peakCachedPartitions) {
    rdd.peakCachedPartitions = rdd.replicasByPartition.size;
    record.numCachedPartitions = rdd.peakCachedPartitions;
    record.memorySize = rdd.memorySize;
    record.diskSize = rdd.diskSize;
  }
  state.rddInfo.set(rddId, record);
  return null;
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
  // A restarted execution carries a new plan: its next end must resolve it again.
  state.resolvedPlanExecutions.delete(exec.id);
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
  // A repeated end for an execution whose plan was already posted: its raw plan is gone, and the
  // plain 'sql' copy below would replace the model entry that holds the planTree (onSql overwrites).
  if (state.resolvedPlanExecutions.has(event.executionId)) return null;

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
  state.resolvedPlanExecutions.add(event.executionId);

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
      mergeStageRddInfo(info, id, state, false);
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

    case 'SparkListenerBlockUpdated':
      return recordBlockUpdate(event, state);

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

const QUOTE = 0x22, BACKSLASH = 0x5c, NEWLINE = 0x0a;

// Index of the closing quote of the JSON string whose content starts at `valueStart`: the first
// quote preceded by an even number of backslashes. -1 when the string is unterminated.
function closingQuoteIndex(line: string, valueStart: number): number {
  for (let quote = line.indexOf('"', valueStart); quote !== -1; quote = line.indexOf('"', quote + 1)) {
    let backslashes = 0;
    for (let i = quote - 1; i >= valueStart && line.charCodeAt(i) === BACKSLASH; i--) backslashes++;
    if (backslashes % 2 === 0) return quote;
  }
  return -1;
}

// Byte-level closingQuoteIndex over a chunk that starts inside the string, stopping at `limit`.
// `carried` is the backslash run the previous chunk ended with, which continues into this one.
// A quote byte never occurs inside a UTF-8 multibyte sequence.
function closingQuoteAt(buf: Uint8Array, limit: number, carried: number): number {
  for (let q = buf.indexOf(QUOTE); q !== -1 && q < limit; q = buf.indexOf(QUOTE, q + 1)) {
    let i = q - 1;
    while (i >= 0 && buf[i] === BACKSLASH) i--;
    if ((q - 1 - i + (i < 0 ? carried : 0)) % 2 === 0) return q;
  }
  return -1;
}

// Returns `line` with the physicalPlanDescription string value emptied, or `line` unchanged when
// the key isn't found in Spark's compact form. The key pattern can't match inside another JSON
// string: there its quotes would be backslash-escaped. buildChunkDecoder already empties a value
// that spans chunks, so here the value is empty or within one chunk.
export function stripPlanDescription(line: string): string {
  if (!line.startsWith(SQL_UI_EVENT_PREFIX)) return line;
  const keyAt = line.indexOf(PLAN_DESCRIPTION_KEY);
  if (keyAt === -1) return line;
  const valueStart = keyAt + PLAN_DESCRIPTION_KEY.length;
  if (line.charCodeAt(valueStart) === QUOTE) return line; // already empty
  const quote = closingQuoteIndex(line, valueStart);
  // Unterminated string (a truncated line): leave it for JSON.parse to reject.
  if (quote === -1) return line;
  return line.slice(0, valueStart) + line.slice(quote);
}

const TASK_END_PREFIX = '{"Event":"SparkListenerTaskEnd",';
const ACCUMULABLES_KEY = '"Accumulables":[';
const ACCUMULABLE_ID_KEY = '"ID":';
// Beyond 15 digits the digit loop below could round differently from JSON.parse.
const MAX_ACCUMULABLE_ID_DIGITS = 15;

// Parses a TaskEnd line with its Task Info Accumulables array reduced to the `{ID}` entries
// accumulateTask reads, or returns null for the caller to parse the line whole. That array is 71%
// of TaskEnd bytes on the largest real log, where parsing its TaskEnd lines took 1.3s (0.5s here).
// The IDs are read with a string scan and the array is cut out before JSON.parse, but only when
// every entry has Spark's flat form (`{"ID":n,...}`, ID first, no nested array): any `{` that
// doesn't open `{"ID":n` or any `[` in the array (updatedBlockStatuses) falls back. A `]` inside a
// Name string cuts the array short and leaves invalid JSON, which falls back too.
export function parseTaskEnd(line: string): unknown {
  if (!line.startsWith(TASK_END_PREFIX)) return null;
  const keyAt = line.indexOf(ACCUMULABLES_KEY);
  if (keyAt === -1) return null;
  const from = keyAt + ACCUMULABLES_KEY.length;
  const close = line.indexOf(']', from);
  if (close === -1) return null;
  const nested = line.indexOf('[', from);
  if (nested !== -1 && nested < close) return null;
  const ids: number[] = [];
  for (let brace = line.indexOf('{', from); brace !== -1 && brace < close; brace = line.indexOf('{', brace + 1)) {
    if (!line.startsWith(ACCUMULABLE_ID_KEY, brace + 1)) return null;
    const digitsFrom = brace + 1 + ACCUMULABLE_ID_KEY.length;
    let i = digitsFrom, id = 0;
    for (let c = line.charCodeAt(i); c >= 48 && c <= 57; c = line.charCodeAt(++i)) id = id * 10 + c - 48;
    if (i === digitsFrom || i - digitsFrom > MAX_ACCUMULABLE_ID_DIGITS) return null;
    const after = line.charCodeAt(i);
    if (after !== 0x2c && after !== 0x7d) return null; // `,` or `}`
    ids.push(id);
  }
  let parsed: { 'Task Info'?: { Accumulables?: unknown } } | null;
  try {
    parsed = JSON.parse(line.slice(0, from) + line.slice(close));
  } catch {
    return null;
  }
  const info = parsed?.['Task Info'];
  if (!info || !Array.isArray(info.Accumulables) || info.Accumulables.length !== 0) return null;
  info.Accumulables = ids.map((ID) => ({ ID }));
  return parsed;
}

const ADAPTIVE_UPDATE_PREFIX =
  '{"Event":"org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate","executionId":';
// More digits than an executionId (a JVM long) has, so a head this long past the prefix holds the
// id and the comma after it.
const MAX_EXECUTION_ID_DIGITS = 20;

// An AQE update replaces its execution's whole plan, and nothing reads a plan an update replaced:
// only the last one before SQLExecutionEnd is resolved. So while the execution is open, only its
// latest update is kept, as unparsed text, and superseded ones are never parsed. On the largest
// real log 541 of 664 updates were superseded, 1.1 MB of plan JSON each after the plan text is
// cut. Returns false (parse it now, as any other line) unless the line is Spark's compact form
// ending in an object-valued `sparkPlanInfo`, its last field: a null-plan update keeps the
// previous plan, so it can't supersede one. Trade-off: a malformed superseded update is never
// seen, so it no longer counts as a skipped line.
//
// These updates span decode slices, so `line` is a cons string: the prefix and suffix checks read
// `joined`'s flat pieces instead, or a superseded update is copied flat only to be dropped (541
// copies of 1.1 MB on that log). A piece too short to hold what is checked falls back to `line`.
function deferAdaptiveUpdate(
  line: string, state: ParserState, emit: (msg: unknown) => void, joined?: JoinedLine,
): boolean {
  const head = joined && joined.head.length > ADAPTIVE_UPDATE_PREFIX.length + MAX_EXECUTION_ID_DIGITS
    ? joined.head : line;
  if (!head.startsWith(ADAPTIVE_UPDATE_PREFIX)) return false;
  let executionId = 0, i = ADAPTIVE_UPDATE_PREFIX.length;
  for (; i < head.length && head.charCodeAt(i) >= 48 && head.charCodeAt(i) <= 57; i++) {
    executionId = executionId * 10 + head.charCodeAt(i) - 48;
  }
  if (i === ADAPTIVE_UPDATE_PREFIX.length || head.charCodeAt(i) !== 0x2c) return false; // no `N,`
  const exec = state.sqlExecutions.get(executionId);
  if (!exec || exec.endTime != null) return false;
  const tail = joined && joined.tail.length >= 2 ? joined.tail : line;
  if (!tail.endsWith('}}')) {
    flushAdaptiveUpdate(executionId, state, emit); // keep this line's order after the pending one
    return false;
  }
  state.pendingAdaptiveUpdates.set(executionId, line);
  return true;
}

function flushAdaptiveUpdate(executionId: number, state: ParserState, emit: (msg: unknown) => void): void {
  const line = state.pendingAdaptiveUpdates.get(executionId);
  if (line === undefined) return;
  state.pendingAdaptiveUpdates.delete(executionId);
  parseAndDispatch(line, state, emit);
}

export function dispatchLine(
  line: string, state: ParserState, emit: (msg: unknown) => void, joined?: JoinedLine,
): void {
  if (deferAdaptiveUpdate(line, state, emit, joined)) return;
  parseAndDispatch(line, state, emit);
}

// With logBlockUpdates on, most BlockUpdated lines are broadcast/shuffle blocks recordBlockUpdate
// ignores. Spark writes "Event" first and "Block ID" as a plain string, so those lines can be
// dropped on a substring test before paying for JSON.parse.
const BLOCK_UPDATED_PREFIX = '{"Event":"SparkListenerBlockUpdated",';
const RDD_BLOCK_ID_FRAGMENT = '"Block ID":"rdd_';

function parseAndDispatch(line: string, state: ParserState, emit: (msg: unknown) => void): void {
  if (line.startsWith(BLOCK_UPDATED_PREFIX) && !line.includes(RDD_BLOCK_ID_FRAGMENT)) return;
  let parsed: unknown;
  try {
    parsed = parseTaskEnd(line) ?? JSON.parse(stripPlanDescription(line));
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
  if (result.data.Event === 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd') {
    flushAdaptiveUpdate(result.data.executionId, state, emit);
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

// Speculation totals of every stage a late TaskEnd added waste to (accountLateSpeculativeLoser),
// re-posted once before `done`: the stage message posted at completion carried the earlier totals.
export function collectLateSpeculationWaste(
  state: ParserState,
): Map<number, { speculationWasteMs: number; speculationWastedAttempts: number }> {
  const out = new Map<number, { speculationWasteMs: number; speculationWastedAttempts: number }>();
  for (const [id, stage] of state.stages) {
    if (stage.lateSpeculationWaste) {
      out.set(id, { speculationWasteMs: stage.speculationWasteMs, speculationWastedAttempts: stage.speculationWastedAttempts });
    }
  }
  return out;
}

export function emitParseCompletion(state: ParserState, emit: (msg: unknown) => void, linesProcessed: number): void {
  // Executions that never ended keep their latest AQE update, as they did before it was deferred.
  for (const executionId of [...state.pendingAdaptiveUpdates.keys()]) flushAdaptiveUpdate(executionId, state, emit);
  emit({ type: 'progress', pct: 1, linesProcessed });
  emit({ type: 'runAggregates', data: computeRunAggregates(state.taskStore) });
  emit({ type: 'stageSpeculationWaste', data: collectLateSpeculationWaste(state) });
  emit({ type: 'stageExecutorMetrics', data: collectStageExecutorMetrics(state) });
  emit(appMessage(state));
  emit({ type: 'done', skippedLines: state.skippedLines });
  state.accumState.clear();
}
