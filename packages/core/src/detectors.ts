import { pathBasename, formatBytes, IMPACT_BAND_ORDER, MS_PER_CORE_HOUR } from './format-utils.ts';
import { medianOfSorted } from './median.ts';
import { shareLabel } from './finding-presentation.ts';
import { scanRelationId } from './plan-summary.ts';
import { allocatedCoreMs, computeAllocation } from './allocation.ts';
import { computePeakConcurrentCores, computePeakConcurrentExecutorCount } from './core-count.ts';
import { walkPlanTree } from './plan-tree-walk.ts';
import { computeCoreLocalityRatio } from './core-locality-ratio.ts';
import { tailRecoveryMs, tailRemovedWorkMs, stragglerFixLongestTaskMs, type TailStage } from './occupancy.ts';
import { IMPACT_FLOOR_PCT_WARN, IMPACT_FLOOR_PCT_CRIT, appDurationMs } from './impact-band.ts';
import {
  BROADCAST_BANDWIDTH_BPS, EXECUTOR_STARTUP_OVERHEAD_MS, FILE_OPEN_OVERHEAD_MS, IDEAL_BYTES_PER_PARTITION_TASK,
  NETWORK_FETCH_PENALTY_MS, RE_READ_THROUGHPUT_BPS, SHUFFLE_THROUGHPUT_BPS, SPILL_IO_THROUGHPUT_BPS, TAIL_CLAIM,
  TASK_SCHEDULING_OVERHEAD_MS, costOnly, fetchWaitWallClockMs, measuredTaskOverhead, multiStageImpact, noWasteModel,
  retryWallClockMs, singleStageImpact, stageIoParallelism, stageMappableWasteOrCostOnly, tasksMostlyIdle,
  type EstimateCtx,
} from './impact-model.ts';
import { isExchangeNode, isBroadcastExchangeNode } from './plan-node-detail.ts';
import { totalExecutorCpuMs } from './run-totals.ts';
import { DUPLICATE_SUBTREE_DIFFERING_NOTE, duplicateSubtreeDetail, SLOW_HOST_DIMENSION_LABEL } from './finding-generic-recommendation.ts';
import { stageIdsForSqlExec } from './sql-stages.ts';
import { cyrb53 } from './string-hash.ts';
import { codeFix, decreaseConf, increaseConf, setConf } from './remediation.ts';
import { MAX_FAILURE_GROUPS, describeTaskFailure, type TaskFailureGroup } from './task-failure.ts';
import type { Finding, PlanNode, FixEffort, ImpactEstimate, RawWasteFigure } from './types.ts';
import type { FindingOf, Remediation, SkewOrigin, StageReads, ShufflePartitions, BroadcastThreshold, SlowHostFinding, TaskAttemptSample, TunedThresholds } from './finding-types.ts';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const TB = 1024 * GB;

// Labels a byte threshold in this file's binary units, so a 1 GiB default reads '1 GB'.
function binaryThresholdLabel(bytes: number): string {
  const [unit, size] = ([['GB', GB], ['MB', MB], ['KB', 1024]] as const).find(([, u]) => bytes >= u) ?? ['bytes', 1];
  return `${Math.round(bytes / size * 10) / 10} ${unit}`;
}

// Local runtime shapes.
//
// types.ts's Stage/SqlExecution/SparkAppInfo describe the posted AppModel surface for the view
// layer (with a catch-all index signature). This file needs the FULL set of fields finalizeStage
// computes and event-handlers.ts records carry, accessed directly (arithmetic, comparisons), so
// an index-signature type would force an `unknown` cast at nearly every access. Every field below
// is verified against a real access here.
interface DetectorHostStat { host: string; taskCount: number; totalDuration: number; }
interface DetectorExecutorStat {
  executorId: string; taskCount: number; totalDuration: number;
  inputBytes: number; shuffleReadBytes: number; shuffleWriteBytes: number;
}
interface DetectorFailureReason { reason: string; count: number; }
interface DetectorLocalityStat { locality: string; count: number; }
type DetectorFailedTaskSample = TaskAttemptSample;
// Per-executor snapshot from a StageExecutorMetrics event: a loose bag of Spark's
// ExecutorMetrics field names, only a few of which any detector reads.
interface DetectorExecutorMetricsSnapshot {
  jvmHeapMemory?: number;
  onHeapStorageMemory?: number;
  offHeapStorageMemory?: number;
  [key: string]: number | undefined;
}

export interface DetectorStage {
  id: number;
  sqlExecutionId?: number | null;
  taskCount: number;
  failedTasks: number;
  inputBytes: number;
  outputBytes: number;
  submittedAt: number;
  completedAt: number;
  shuffleReadBytes: number;
  shuffleReadP50: number;
  shuffleReadMax: number;
  memoryBytesSpilled: number;
  spillClassification: 'skew' | 'volume' | 'unclassified';
  spillDiskMax?: number;
  spillMemMax?: number;
  spillDiskP50?: number;
  spillMemP50?: number;
  gcPct: number;
  executorRunTime: number;
  executorCpuTime: number;
  taskDurationP50: number;
  taskDurationP95: number;
  taskDurationMax: number;
  hostStats?: DetectorHostStat[];
  executorStats?: DetectorExecutorStat[];
  executorMetrics: Map<string, DetectorExecutorMetricsSnapshot>;
  failureReasons?: DetectorFailureReason[];
  failureGroups?: TaskFailureGroup[];
  localityStats?: DetectorLocalityStat[];
  stragglerCount: number;
  stragglerExcessMs?: number;
  longestNonStragglerMs?: number;
  peakConcurrentTasks?: number;
  speculativeTasks: number;
  speculationWastedAttempts: number;
  speculationWasteMs: number;
  wastedAttempts: number;
  retryWasteMs: number;
  stageFailureReason: string | null;
  failedTaskSamples?: DetectorFailedTaskSample[];
  retryTaskSamples?: DetectorFailedTaskSample[];
}

export interface DetectorSqlExec {
  id: number;
  planTree?: PlanNode | null;
}

interface DetectorRddInfo {
  id: number;
  name: string;
  storageLevel: { useMemory: boolean; useDisk: boolean };
  numPartitions: number;
  numCachedPartitions: number;
  memorySize: number;
  diskSize: number;
  storageSource?: 'rddInfo' | 'blockUpdates';
}

interface DetectorApp {
  startTime?: number;
  endTime?: number | null;
  resources?: {
    executor?: { cores?: number; memoryMB?: number; memoryOverheadMB?: number };
    dynamicAllocationEnabled?: boolean;
    shuffleServiceEnabled?: boolean;
    serializer?: string;
  };
  config?: Record<string, string>;
  sparkVersion?: string | null;
  rddInfo?: Map<number, DetectorRddInfo>;
  // SparkListenerBlockUpdated events seen for rdd_* blocks (0 when logBlockUpdates was off).
  rddBlockUpdates?: number;
}

interface DetectorExecutorAddedEvent { executorId: string; timestamp: number; totalCores?: number; }
interface DetectorExecutorRemovedEvent { executorId: string; timestamp: number; }
interface DetectorJob {
  result: string | null;
  succeeded: boolean | null;
  // Nullable as on types.ts's Job: a job can lack either timestamp if the log never recorded it.
  submissionTime: number | null;
  completionTime: number | null;
}

// The full context analyze() passes as every stage/sql detect()'s second arg, and as the first
// arg for 'app' scope. 'config' scope gets a narrower `{ app }` (auditConfig) instead.
//
// `app` is nullable as on AppModel.app: a malformed or cut-short log may have no app record, so
// every app-reading detector guards it. `runAggregates.busyCoreMs` is optional for the same reason.
export interface DetectorCtx {
  app: DetectorApp | null;
  stages: Map<number, DetectorStage>;
  executorsAdded: DetectorExecutorAddedEvent[];
  executorsRemoved: DetectorExecutorRemovedEvent[];
  jobs: Map<number, DetectorJob>;
  sql: Map<number, DetectorSqlExec>;
  runAggregates?: { busyCoreMs?: number } | null;
  // The one EstimateCtx analyze() also hands every estimate(): a detector's runtime floor clips
  // its claim against the same occupancy sweep the displayed savings come from.
  impact: EstimateCtx;
}

// auditConfig(app) calls every config-scope detect({ app }) with whatever appModel.app is
// (SparkAppInfo | null), independent of DetectorCtx.
export interface DetectorConfigTarget {
  app: DetectorApp | null;
}

interface SpillThresholds {
  singleTaskDiskGiB: number; singleTaskMemGiB: number;
  highDiskGiB: number; highTaskDiskMB: number; highMemGiB: number;
  medDiskMB: number; medMemGiB: number;
  skewRatio: number; skewDiskFloorMB: number; skewMemFloorMB: number; skewMinTasks: number;
  stageFloorPct: number;
}

// SpillPressureDetector (5a) + SpillSkewDetector (5b).
function computeSpillMagnitude(
  stage: Pick<DetectorStage, 'taskCount' | 'spillDiskMax' | 'spillMemMax' | 'spillDiskP50' | 'spillMemP50'>,
  t: SpillThresholds,
): { magnitude: 'severe' | 'high' | 'medium' } | null {
  const { taskCount, spillDiskMax = 0, spillMemMax = 0, spillDiskP50 = 0, spillMemP50 = 0 } = stage;
  // 5a: absolute volume, branching on task count.
  if (taskCount === 1) {
    if (spillDiskMax >= t.singleTaskDiskGiB * GB || spillMemMax >= t.singleTaskMemGiB * GB) return { magnitude: 'severe' };
  } else {
    const perTaskDisk = taskCount > 0 ? spillDiskMax / taskCount : 0; // approximation: max used as per-task proxy
    if (spillDiskMax >= t.highDiskGiB * GB || perTaskDisk >= t.highTaskDiskMB * MB || spillMemMax >= t.highMemGiB * GB) return { magnitude: 'high' };
    if (spillDiskMax >= t.medDiskMB * MB || spillMemMax >= t.medMemGiB * GB) return { magnitude: 'medium' };
  }
  // 5b: ratio+floor skew (requires enough tasks).
  if (taskCount >= t.skewMinTasks) {
    if (spillDiskP50 > 0 && spillDiskMax / spillDiskP50 > t.skewRatio && spillDiskMax >= t.skewDiskFloorMB * MB) return { magnitude: 'high' };
    if (spillMemP50 > 0 && spillMemMax / spillMemP50 > t.skewRatio && spillMemMax >= t.skewMemFloorMB * MB) return { magnitude: 'medium' };
  }
  return null;
}

function pickDominantReason(reasons: DetectorFailureReason[] | undefined): string | null {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  return [...reasons].sort((a, b) => b.count - a.count)[0].reason;
}

// Shared by the three Plan Advisor detectors: union the given nodes' own stageIds, or fall back
// to the whole execution's stage set when none have coverage (never a partial blend). `fallback`
// is a param so callers compute stageIdsForSqlExec once per detect() and reuse it per finding.
export function unionStageIds(nodes: PlanNode[], fallback: number[]): number[] {
  const union = new Set<number>();
  for (const node of nodes) for (const sid of node.stageIds ?? []) union.add(sid);
  return union.size > 0 ? [...union].sort((a, b) => a - b) : fallback;
}

// Bottom-up shape computation for duplicate-subtree detection and the
// cachingOpportunity composite detector. `size` is the subtree node count; the default
// fingerprint encodes operator name + sorted metric NAMES (never values, per spec) + a digest
// of each child's fingerprint, so two subtrees with the same shape but different values still
// collide. Digesting children keeps each fingerprint O(own size): embedding the full child
// strings made every node carry its whole subtree, O(n x depth) text on deep real plans.
//
// opts.includeDetail (default false) folds root's own detail (via opts.normalizeDetail) into
// ONLY root's fingerprint, never a child's: lets a caller match "this node's own detail + shape"
// without descendant scan detail entering the comparison.
interface PlanShape { size: number; fingerprint: string; }

export function computePlanShapes(
  root: PlanNode,
  opts: { includeDetail?: boolean; normalizeDetail?: (d: string) => string } = {},
): { shapeOf: WeakMap<PlanNode, PlanShape>; allNodes: PlanNode[] } {
  const { includeDetail = false, normalizeDetail: normalize = (d: string) => d } = opts;
  const shapeOf = new WeakMap<PlanNode, PlanShape>();
  const allNodes: PlanNode[] = [];
  function visit(node: PlanNode, isRoot: boolean): PlanShape {
    allNodes.push(node);
    // A read half wrapping a write half (the Exchange split from
    // resolvePlanTree, see event-handlers.ts) is one logical Spark operator
    // for subtree-shape purposes. Without this, every real Exchange in a
    // matched subtree would count twice, inflating duplicatePlanSubtree's
    // reported subtreeSize and shifting its groupIndex-derived findingIds
    // for an otherwise-unchanged plan. Skip straight through the write
    // wrapper: size comes from its real children, and metricNames from its
    // real metrics (the read half's own metrics are always empty), so
    // fingerprint distinctiveness between different real Exchanges is
    // preserved too.
    const writeHalf = node.exchangeRole === 'read' ? node.children[0] : null;
    const realChildren = writeHalf ? writeHalf.children : (node.children ?? []);
    const realMetrics = writeHalf ? writeHalf.metrics : node.metrics;
    const childShapes = realChildren.map((c) => visit(c, false));
    const size = 1 + childShapes.reduce((sum, c) => sum + c.size, 0);
    const metricNames = (realMetrics ?? []).map((m) => m.name).sort().join(',');
    const childFingerprints = childShapes.map((c) => cyrb53(c.fingerprint)).join(',');
    const fingerprint = isRoot && includeDetail
      ? `${node.name}[${metricNames}]<${normalize(node.detail ?? '')}>{${childFingerprints}}`
      : `${node.name}[${metricNames}]{${childFingerprints}}`;
    const shape = { size, fingerprint };
    shapeOf.set(node, shape);
    return shape;
  }
  visit(root, true);
  return { shapeOf, allNodes };
}

// Normalizes an anchor join/union node's detail for the cachingOpportunity composite
// fingerprint. Strips per-analysis numbering (expr ids, plan/codegen ids) and AQE's runtime
// BuildLeft/BuildRight choice (can flip between runs), then canonicalizes commutative equality
// operand order so `A.x = B.y` and `B.y = A.x` collide. Join type, columns, literals are kept.
export function normalizeDetail(detail: string): string {
  let s = detail
    .replace(/#\d+L?/g, '')
    .replace(/,?\s*plan_id=\d+/g, '')
    .replace(/\[codegen id\s*:\s*\d+\]/gi, '[codegen id]')
    .replace(/\bBuild(Left|Right)\b/g, 'BuildSide');
  // The lookbehind only skips starts inside an identifier, which can't match unless the
  // identifier's own start already did: same output, without re-scanning each identifier from
  // every one of its letters (O(length^2) on the 6.8 KB average join detail of the largest real
  // log; 64ms -> 40ms per analyze()).
  s = s.replace(/(?<![A-Za-z_])([A-Za-z_][\w.]*)\s*=\s*([A-Za-z_][\w.]*)/g, (_m, l, r) => {
    const [a, b] = [l, r].sort();
    return `${a} = ${b}`;
  });
  return s;
}

const JOIN_NAME_RE = /Join/i;

// scanRelationId per plan node, memoized: cachingOpportunity's relation walk and
// findCompositeCandidates both classify every node of every execution, and a JDBC scan's detail
// carries its whole inner SQL, so the repeated regex passes were a measurable share of
// analyze(). Keyed by node identity: a resolved plan tree is never mutated after the parser
// posts it.
const relationIdByNode = new WeakMap<PlanNode, string | null>();
function relationIdOf(node: PlanNode): string | null {
  let rid = relationIdByNode.get(node);
  if (rid === undefined) {
    rid = scanRelationId(node.name ?? '', node.detail ?? '');
    relationIdByNode.set(node, rid);
  }
  return rid;
}

// Structural operator kind for cachingOpportunity's composite detection: 'join' covers every
// Spark join physical operator; 'union' is Spark's exact `Union` node. CartesianProduct is
// deliberately excluded (out of scope, as in plan-summary.ts).
export function planOperatorKind(name: string): 'join' | 'union' | null {
  if (JOIN_NAME_RE.test(name)) return 'join';
  if (name === 'Union') return 'union';
  return null;
}

// Single bottom-up O(n) pass producing one composite candidate per join/union node. Deliberately
// does NOT call computePlanShapes per node (subtrees overlap, that would be O(n·k) on
// star/snowflake joins): computes the plain fingerprint once and merges each subtree's
// leaf-relation byte map bottom-up. A join/union's anchor fingerprint folds only its OWN
// normalized detail, inline in O(1). `ancestorNodes` threads down via the call stack so
// nested-composite dedupe needs no separate tree walk.
export interface CompositeCandidate {
  node: PlanNode;
  operator: 'join' | 'union';
  fingerprint: string;
  leafRelationBytes: Map<string, number>;
  ancestorNodes: PlanNode[];
}

export function findCompositeCandidates(root: PlanNode): CompositeCandidate[] {
  const candidates: CompositeCandidate[] = [];
  const path: PlanNode[] = [];
  function visit(node: PlanNode): { fingerprint: string; leafRelationBytes: Map<string, number> } {
    path.push(node);
    const childResults = (node.children ?? []).map(visit);
    path.pop();

    const metricNames = (node.metrics ?? []).map((m) => m.name).sort().join(',');
    // Child digests, as in computePlanShapes: deterministic, so still comparable across executions.
    const childFingerprints = childResults.map((r) => cyrb53(r.fingerprint)).join(',');
    const fingerprint = `${node.name}[${metricNames}]{${childFingerprints}}`;

    const leafRelationBytes = new Map<string, number>();
    const rid = relationIdOf(node);
    if (rid) {
      const bytesMetric = (node.metrics ?? []).find((m) => m.name === FILES_READ_BYTES);
      leafRelationBytes.set(rid, (leafRelationBytes.get(rid) ?? 0) + (bytesMetric ? bytesMetric.value : 0));
    }
    for (const child of childResults) {
      for (const [crid, bytes] of child.leafRelationBytes) {
        leafRelationBytes.set(crid, (leafRelationBytes.get(crid) ?? 0) + bytes);
      }
    }

    const operator = planOperatorKind(node.name ?? '');
    if (operator) {
      candidates.push({
        node,
        operator,
        fingerprint: `${node.name}[${metricNames}]<${normalizeDetail(node.detail ?? '')}>{${childFingerprints}}`,
        leafRelationBytes: new Map(leafRelationBytes),
        ancestorNodes: path.slice(),
      });
    }

    return { fingerprint, leafRelationBytes };
  }
  visit(root);
  return candidates;
}


// First scanned relation identity in a subtree (pre-order), or null when none. Surfaced on
// duplicatePlanSubtree findings as `sampleRelation` so a user can tell apart same-shaped groups
// that scan different tables. Best-effort only: null for scan-less subtrees, can coincide across
// groups; findDuplicateSubtrees's groupIndex is the actual discriminator findingId relies on.
function firstLeafRelationId(node: PlanNode): string | null {
  let found: string | null = null;
  walkPlanTree(node, (n) => {
    if (found) return;
    found = relationIdOf(n);
  });
  return found;
}

// Groups nodes by fingerprint, keeping groups of size >= minOccurrences whose subtree size is
// >= minSubtreeSize. De-overlap: process largest-subtree-first, and once a group is accepted mark
// every node in its matches "claimed" so a smaller fully-nested duplicate is dropped; occurrences
// of a smaller group OUTSIDE any accepted match still count.
interface DuplicateSubtreeGroup {
  rootName: string;
  subtreeSize: number;
  occurrences: number;
  isExchangeRoot: boolean;
  sampleRelation: string | null;
  groupIndex: number;
  nodes: PlanNode[];
}

export function findDuplicateSubtrees(
  root: PlanNode,
  { minSubtreeSize, minOccurrences }: { minSubtreeSize: number; minOccurrences: number },
): DuplicateSubtreeGroup[] {
  const { shapeOf, allNodes } = computePlanShapes(root);
  // Defensive, not load-bearing: computePlanShapes's visit() already skips
  // straight through a read node to its write half's real children, so no
  // write-half node is ever pushed into allNodes in the first place, this
  // filter can structurally never exclude anything. Kept in case that
  // invariant ever changes upstream.
  const eligible = allNodes.filter(n => shapeOf.get(n)!.size >= minSubtreeSize && n.exchangeRole !== 'write');

  const groups = new Map<string, PlanNode[]>();
  for (const n of eligible) {
    const fp = shapeOf.get(n)!.fingerprint;
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp)!.push(n);
  }

  const candidates = [...groups.values()]
    .filter(nodes => nodes.length >= minOccurrences)
    .sort((a, b) => shapeOf.get(b[0])!.size - shapeOf.get(a[0])!.size);

  const claimed = new WeakSet<PlanNode>();
  const markClaimed = (node: PlanNode) => {
    claimed.add(node);
    for (const c of (node.children ?? [])) markClaimed(c);
  };

  const results: DuplicateSubtreeGroup[] = [];
  for (const nodes of candidates) {
    const unclaimed = nodes.filter(n => !claimed.has(n));
    if (unclaimed.length < minOccurrences) continue;
    for (const n of unclaimed) markClaimed(n);
    results.push({
      rootName: unclaimed[0].name,
      subtreeSize: shapeOf.get(unclaimed[0])!.size,
      occurrences: unclaimed.length,
      isExchangeRoot: isExchangeNode(unclaimed[0]),
      sampleRelation: firstLeafRelationId(unclaimed[0]),
      // Deterministic position within this execution's group list: the actual uniqueness
      // guarantee findingId relies on, since sampleRelation is best-effort (null or coincident).
      groupIndex: results.length,
      nodes: unclaimed,
    });
  }
  return results;
}

// True when every occurrence also agrees node-for-node on normalized detail (filters, columns,
// scanned table, literals). The fingerprint ignores detail, so occurrences can be same-shaped
// branches over different data; only identical ones are repeated work that computing once would
// save. AQE query-stage numbers (`ShuffleQueryStage 718` vs `720`) name the same computation's
// runtime stage and are ignored too. On the 14 real logs, 270 of 546 groups differed beyond that.
function occurrencesHaveIdenticalDetails(occurrences: PlanNode[]): boolean {
  const detailsOf = (root: PlanNode): string[] => {
    const out: string[] = [];
    walkPlanTree(root, (n) => out.push(n.detail ?? ''));
    return out;
  };
  const normalize = (d: string): string => normalizeDetail(d).replace(/\b(\w+QueryStage)\s+\d+/g, '$1');
  const first = detailsOf(occurrences[0]);
  const firstNormalized: (string | undefined)[] = [];
  for (const other of occurrences.slice(1)) {
    const details = detailsOf(other);
    if (details.length !== first.length) return false;
    for (let i = 0; i < first.length; i++) {
      if (details[i] === first[i]) continue;
      firstNormalized[i] ??= normalize(first[i]);
      if (normalize(details[i]) !== firstNormalized[i]) return false;
    }
  }
  return true;
}

// Stages that run nothing but the duplicated occurrences' operators: every operator attributed to
// the stage is inside `nodes`. A stage shared with operators outside them (the join consuming the
// subtree, the other join side) does other work too, so its time isn't the subtree's to claim;
// counting it also let sibling groups claim the same stage twice. A WholeStageCodegen wrapper and
// an Exchange's write half aren't other work (the fused pipeline around an operator, the shuffle
// write of its output), so they're left out of both counts; on the 14 real logs they were the
// only outside node on 426 stages.
function countsTowardStage(node: PlanNode): boolean {
  return node.exchangeRole !== 'write' && !node.name.startsWith('WholeStageCodegen');
}

function operatorCountByStage(nodes: Iterable<PlanNode>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const node of nodes) {
    if (!countsTowardStage(node)) continue;
    for (const sid of node.stageIds ?? []) counts.set(sid, (counts.get(sid) ?? 0) + 1);
  }
  return counts;
}

function stageOperatorShares(nodes: PlanNode[], executionCounts: Map<number, number>): Record<number, number> {
  const shares: Record<number, number> = {};
  for (const [sid, count] of operatorCountByStage(nodes)) shares[sid] = count / (executionCounts.get(sid) ?? count);
  return shares;
}

// Fingerprint matching compares operator + metric names only, not literal values or expr IDs
// (see the finding's validationRequired text), so a small pattern repeated the bare minimum
// number of times is the case most likely to be coincidental rather than real duplicated work.
// A bigger matched subtree, or more repeats, are each on their own strong corroborating evidence
// that the match is real: the odds of two semantically-different query branches producing an
// identical operator-name sequence shrink fast as the sequence grows or repeats.
function duplicateSubtreeConfidence(
  subtreeSize: number,
  occurrences: number,
  thresholds: { minSubtreeSize: number; minOccurrences: number },
): 'low' | 'medium' | 'high' {
  if (subtreeSize <= thresholds.minSubtreeSize && occurrences <= thresholds.minOccurrences) return 'low';
  if (subtreeSize >= thresholds.minSubtreeSize * 2 || occurrences >= thresholds.minOccurrences + 2) return 'high';
  return 'medium';
}

// Exact metric names Spark emits, verified against a real SQLExecutionStart's sparkPlanInfo.
// The write-side byte metric is "written output", not "size of written files".
const FILES_READ_COUNT = 'number of files read';
const FILES_READ_BYTES = 'size of files read';
const FILES_WRITTEN_COUNT = 'number of written files';
const FILES_WRITTEN_BYTES = 'written output';

// Byte size of a join-side subtree for broadcast sizing. Stops
// descending at a node with a "data size" metric: that value already aggregates everything
// beneath it, so summing further would double-count. Only recurses when no such metric.
function sumBoundarySize(node: PlanNode): number {
  const m = (node.metrics ?? []).find(x => x.name === 'data size');
  if (m) return m.value;
  let sum = 0;
  for (const c of (node.children ?? [])) sum += sumBoundarySize(c);
  return sum;
}

// Nodes that fed sumBoundarySize's total: mirrors its recursion exactly so implicated stageIds
// line up with the size actually compared.
function boundarySizeContributors(node: PlanNode): PlanNode[] {
  const m = (node.metrics ?? []).find((x) => x.name === 'data size');
  if (m) return [node];
  const out: PlanNode[] = [];
  for (const c of (node.children ?? [])) out.push(...boundarySizeContributors(c));
  return out;
}

// Max/median deviation ratio over a list of {key, value}; returns the
// exceeding entry's key + ratio, or null when < 3 samples or median 0.
function maxMedianRatio(
  samples: { key: string; value: number }[],
): { key: string; ratio: number; value: number } | null {
  if (samples.length < 3) return null;
  const vals = samples.map(s => s.value).sort((a, b) => a - b);
  const median = medianOfSorted(vals);
  if (median <= 0) return null;
  const top = samples.reduce((a, b) => (b.value > a.value ? b : a));
  return { key: top.key, ratio: top.value / median, value: top.value };
}

export interface DetectorCatalogEntry {
  type: DetectorType;
  version: number;
  scope: DetectorScope;
  // The thresholds the run used: the entry's own, or with a user's overrides merged in.
  thresholds?: DetectorThresholds;
  docAnchor?: string;
  // Present only when an override moved a threshold off its default (threshold-overrides.ts).
  tunedThresholds?: TunedThresholds;
}

// Machine-readable detector metadata for the evidence report (no `detect` closure), so a
// portable report records which detector + thresholds produced each finding. These are the
// defaults; tunedDetectorCatalog() (threshold-overrides.ts) is the same rows under overrides.
export function detectorCatalog(): DetectorCatalogEntry[] {
  return DETECTORS.map((d) => ({
    type: d.type,
    version: d.version ?? 1,
    scope: d.scope,
    thresholds: d.thresholds,
    docAnchor: d.docAnchor,
  }));
}

// True task-duration skew ratio: P95/median once enough tasks to trust P95, else max/median.
// Null when no measurable median (p50 === 0). Exported so cli/budgets.ts recomputes the same
// ratio rather than reading findings floored at ratioWarn.
// Fields optional: budgets.ts calls this against raw AppModel.stages, whose stages may lack
// these fields (unfinished run). The `as number` casts keep behavior: an absent field yields NaN.
export function computeSkewRatio(
  stage: { taskCount?: number; taskDurationP50?: number; taskDurationP95?: number; taskDurationMax?: number },
  minTasksForP95: number,
): { ratio: number; metric: 'P95/median' | 'max/median' } | null {
  const { taskCount, taskDurationP50: p50, taskDurationP95: p95, taskDurationMax: max } = stage;
  if (p50 === 0) return null;
  return (taskCount ?? 0) >= minTasksForP95
    ? { ratio: (p95 as number) / (p50 as number), metric: 'P95/median' }
    : { ratio: (max as number) / (p50 as number), metric: 'max/median' };
}

// Absolute-magnitude floor as a % of app runtime, not a fixed ms constant: a skew/straggler
// ratio on a few ms is noise in an hours-long run but real in a seconds-long one; a fixed-ms
// floor can't scale. Used by skew/straggler, gated on the same occupancy-clipped tail claim their
// estimate() displays as savings (tailClaimImpact).
// NOT SOURCED: floor percentages are our own noise floor, unvalidated.
// Unknown app timing never suppresses a finding; it just skips the floor gate.
function meetsRuntimeFloor(wasteMs: number, runMs: number | null, floorPct: number): boolean {
  return runMs == null || wasteMs >= runMs * floorPct;
}

// A stage that ran for less than floorPct of the run (a known duration): an estimate clipped to
// the stage can't reach floorPct, so every finding there grades info. A zero-length stage (no
// submission time on older Spark) is not skipped: it gets no estimate and keeps its own band.
function stageBelowRuntimeFloor(stage: DetectorStage, ctx: DetectorCtx, floorPct: number): boolean {
  const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  const runMs = appDurationMs(ctx.app);
  return runMs != null && stageDurationMs > 0 && stageDurationMs < runMs * floorPct;
}

// What a skew or straggler fix claims off its stage: the wall-clock its slow tail costs, the task
// time the fix removes, and the longest task it leaves. One figure, read twice: detect() gates its
// runtime floor on the claim's clipped estimate and estimate() reports that same estimate as the
// savings, so the firing floor and the displayed figure can't disagree.
interface TailClaim {
  wasteMs: number;
  removedCoreWorkMs: number;
  longestTaskAfterFixMs: number;
}

// singleDelta: the slowest task's own excess, the fallback when the stage has no task replay.
function tailClaim(stage: TailStage, singleDelta: number, longestTaskAfterFixMs: number): TailClaim {
  return {
    wasteMs: tailRecoveryMs(stage, singleDelta),
    removedCoreWorkMs: tailRemovedWorkMs(stage, singleDelta),
    longestTaskAfterFixMs,
  };
}

// skew's delta is the task computeSkewRatio's metric sampled (P95 or max) over the median. Fixing
// the skew still waits on the longest task it leaves, as for straggler.
function skewTailClaim(stage: TailStage & { taskDurationP95?: number }, usesP95Branch: boolean): TailClaim {
  const p50 = stage.taskDurationP50 ?? 0;
  const singleDelta = Math.max(0, usesP95Branch ? (stage.taskDurationP95 ?? 0) - p50 : (stage.taskDurationMax ?? 0) - p50);
  return tailClaim(stage, singleDelta, stragglerFixLongestTaskMs(stage));
}

// straggler's delta is the slowest task over the longest one the fix leaves.
function stragglerTailClaim(stage: TailStage): TailClaim {
  const longestTaskAfterFixMs = stragglerFixLongestTaskMs(stage);
  return tailClaim(stage, Math.max(0, (stage.taskDurationMax ?? 0) - longestTaskAfterFixMs), longestTaskAfterFixMs);
}

// A tail claim shortens the stage's longest task, hence TAIL_CLAIM (see occupancy.ts). Its core
// time is the measured task time the fix removes (removedCoreWorkMs).
function tailClaimImpact(claim: TailClaim, stageId: number, ctx: EstimateCtx): ImpactEstimate {
  const estimate = singleStageImpact(claim.wasteMs, stageId, ctx, 'measured', { value: claim.wasteMs, unit: 'ms' },
    { ...TAIL_CLAIM, removedCoreWorkMs: claim.removedCoreWorkMs, longestTaskAfterFixMs: claim.longestTaskAfterFixMs });
  return { ...estimate, coreTimeMs: { low: claim.removedCoreWorkMs, high: claim.removedCoreWorkMs } };
}

// The figure a runtime floor checks: the claim's recoverable wall-clock, not a delta a physical
// floor leaves unrecoverable. Falls back to the raw claim when occupancy data is unavailable.
function tailClaimFloorMs(claim: TailClaim, stageId: number, ctx: DetectorCtx): number {
  return tailClaimImpact(claim, stageId, ctx.impact).wallClock?.high ?? claim.wasteMs;
}

// Spark's default for the properties a detector's fix reads or suggests, for a run that did not log
// them. Undefined when the property is not modeled or its default depends on a version the log did
// not record. A property is modeled only where its default has made a suggestion a no-op; every
// other property a detector suggests defaults off, or to a value other than the suggested one.
function versionDefault(app: DetectorApp | null, key: string): string | undefined {
  if (key === 'spark.sql.shuffle.partitions') return '200';
  if (key === 'spark.sql.autoBroadcastJoinThreshold') return String(10 * MB);
  const version = /^(\d+)\.(\d+)/.exec(app?.sparkVersion ?? '');
  if (version == null) return undefined;
  const [major, minor] = [Number(version[1]), Number(version[2])];
  if (key === 'spark.sql.adaptive.enabled') return major > 3 || (major === 3 && minor >= 2) ? 'true' : 'false';
  if (key === 'spark.sql.adaptive.skewJoin.enabled' || key === 'spark.sql.adaptive.coalescePartitions.enabled') {
    return major >= 3 ? 'true' : undefined;
  }
  return undefined;
}

// The run's effective value of a property: the logged one, else versionDefault's.
function effectiveConf(app: DetectorApp | null, key: string): string | undefined {
  return (app?.config?.[key] ?? versionDefault(app, key))?.trim();
}

// A setting is only a fix when the run's effective conf doesn't already have it: a run that set it,
// or whose Spark version defaults to it, needs another remedy. Booleans compare case-insensitively,
// as Spark parses them.
function loggedAs(app: DetectorApp | null, key: string, suggested: string | boolean): boolean {
  const effective = effectiveConf(app, key);
  return typeof suggested === 'boolean'
    ? effective?.toLowerCase() === String(suggested)
    : effective === suggested;
}

function setConfUnlessLogged(app: DetectorApp | null, key: string, suggested: string | boolean): Remediation[] {
  return loggedAs(app, key, suggested) ? [] : [setConf(key, suggested)];
}

// A switch's fix worded for the run's logged conf: `recommend` names the property while the run
// doesn't have it, `alreadyOn` points at the remedy left once it does, with no remediation.
function switchFix(on: boolean, key: string, suggested: string | boolean, recommend: string, alreadyOn: string): { text: string; remediation: Remediation[] } {
  return on ? { text: alreadyOn, remediation: [] } : { text: recommend, remediation: [setConf(key, suggested)] };
}

const SKEW_KEY_REMEDY = 'salt the key or repartition on a better key';

// What a stage reads, by the dominant side: a stage that reads a shuffle and mostly input files is
// an input stage for any fix that sizes a shuffle's reduce side.
function stageReads(stage: Pick<DetectorStage, 'shuffleReadBytes' | 'inputBytes'>): StageReads {
  if (stage.shuffleReadBytes > 0 && stage.shuffleReadBytes >= stage.inputBytes) return 'shuffle';
  return stage.inputBytes > 0 ? 'input' : 'other';
}

// Whether the run's Spark predates 3.0, which has no AQE skew-join handling to suggest.
function predatesAqeSkewJoin(app: DetectorApp | null): boolean {
  const major = /^(\d+)\./.exec(app?.sparkVersion ?? '');
  return major != null && Number(major[1]) < 3;
}

// What a skewed stage reads, which decides whether AQE skew-join handling can act on it. It splits
// skewed partitions on the shuffle-read side of a sort-merge or shuffled-hash join, so only a stage
// that reads a shuffle, in a SQL execution whose plan has such a join, is 'shuffleJoin'. A plan does
// not say which stage runs which join (a node's stageIds are empty in real logs), so the join is
// matched per execution. 'inputScan' reads mostly files (its tasks differ in input size);
// 'other' is any stage the plan cannot tie to a join (an aggregation's shuffle, no plan, no input),
// and any stage of a run on Spark before 3.0 (skewFix).
function skewOrigin(stage: DetectorStage, ctx: DetectorCtx, shuffleEvidence: boolean): 'shuffleJoin' | 'inputScan' | 'other' {
  if (shuffleEvidence || (stage.shuffleReadBytes > 0 && stage.shuffleReadBytes >= stage.inputBytes)) {
    let hasJoin = false;
    const plan = stage.sqlExecutionId != null ? ctx.sql.get(stage.sqlExecutionId)?.planTree : null;
    walkPlanTree(plan, (node) => { if (SKEW_JOIN_NODES.has(node.name)) hasJoin = true; });
    return hasJoin ? 'shuffleJoin' : 'other';
  }
  return stage.inputBytes > 0 ? 'inputScan' : 'other';
}
const SKEW_JOIN_NODES = new Set(['SortMergeJoin', 'ShuffledHashJoin']);

// The skew finding's fix for the stage's origin. Join-driven skew gets AQE skew-join handling,
// unless the run's effective conf already has it; uneven input gets the file-size remedy.
function skewFix(stage: DetectorStage, ctx: DetectorCtx, shuffleEvidence = false): { origin: SkewOrigin; text: string; remediation: Remediation[] } {
  const origin = skewOrigin(stage, ctx, shuffleEvidence);
  if (origin === 'inputScan') {
    return {
      origin,
      text: 'the stage reads uneven input files: compact small files or split large ones (lower spark.sql.files.maxPartitionBytes)',
      remediation: [decreaseConf('spark.sql.files.maxPartitionBytes')],
    };
  }
  if (origin === 'other') return { origin, text: SKEW_KEY_REMEDY, remediation: [codeFix(SKEW_KEY_REMEDY)] };
  // Before Spark 3.0 there is no AQE skew-join handling, so the stage gets the generic advice.
  if (predatesAqeSkewJoin(ctx.app)) return { origin: 'other', text: SKEW_KEY_REMEDY, remediation: [codeFix(SKEW_KEY_REMEDY)] };
  return { origin, ...skewJoinFix(ctx.app) };
}

function skewJoinFix(app: DetectorApp | null): { text: string; remediation: Remediation[] } {
  const key = 'spark.sql.adaptive.skewJoin.enabled';
  if (loggedAs(app, 'spark.sql.adaptive.enabled', false)) {
    return {
      text: `AQE is off, so enable it (spark.sql.adaptive.enabled) for skew-join handling to apply; otherwise ${SKEW_KEY_REMEDY}`,
      remediation: [setConf('spark.sql.adaptive.enabled', true), ...setConfUnlessLogged(app, key, true)],
    };
  }
  const fix = switchFix(loggedAs(app, key, true), key, true,
    `for join-driven skew, enable AQE skew-join handling (${key}); otherwise ${SKEW_KEY_REMEDY}`,
    `AQE skew-join handling is already on, so ${SKEW_KEY_REMEDY}`);
  // With the switch already on, only the key is left to fix: a change to the job, not a property.
  return fix.remediation.length === 0 ? { ...fix, remediation: [codeFix(SKEW_KEY_REMEDY)] } : fix;
}

// The resources flag is read from the same property as the logged conf.
function dynamicAllocationFix(app: DetectorApp, recommend: string, alreadyOn: string): { text: string; remediation: Remediation[] } {
  const key = 'spark.dynamicAllocation.enabled';
  return switchFix(app.resources?.dynamicAllocationEnabled === true || loggedAs(app, key, true), key, true, recommend, alreadyOn);
}

// Idle capacity is cured by a smaller cluster, which the run's dynamic allocation decides how to
// size. With it on: the cap on how many executors it scales to, and the floor it holds when that
// is logged above 0 (both lowered together). With it off or unset: the alternatives of a fixed
// executor count or switching it on, which dynamicAllocationFix already names, so the
// recommendation reads "either ... or" and a consumer applies one entry. Not executorIdleTimeout:
// autoscalingChurn recommends raising it, so lowering it here would contradict that finding.
function idleCapacityFix(app: DetectorApp, recommend: string, alreadyOnLead: string): { text: string; remediation: Remediation[] } {
  const fix = dynamicAllocationFix(app, recommend, alreadyOnLead);
  // dynamicAllocationFix's remediation is empty exactly when dynamic allocation is already on.
  if (fix.remediation.length > 0) return { ...fix, remediation: [...fix.remediation, decreaseConf('spark.executor.instances')] };
  const holdsFloor = Number.parseInt(app.config?.['spark.dynamicAllocation.minExecutors'] ?? '', 10) > 0;
  return holdsFloor
    ? { text: `${alreadyOnLead} by lowering spark.dynamicAllocation.maxExecutors and spark.dynamicAllocation.minExecutors`,
        remediation: [decreaseConf('spark.dynamicAllocation.maxExecutors'), decreaseConf('spark.dynamicAllocation.minExecutors')] }
    : { text: `${alreadyOnLead} by lowering spark.dynamicAllocation.maxExecutors`, remediation: [decreaseConf('spark.dynamicAllocation.maxExecutors')] };
}

// The run's effective spark.sql.shuffle.partitions (logged, else Spark's 200) as a count, or null
// when the logged value is not a count.
function effectiveShufflePartitions(app: DetectorApp | null): number | null {
  const value = effectiveConf(app, 'spark.sql.shuffle.partitions');
  return value != null && /^\d+$/.test(value) ? Number(value) : null;
}

// Whether partition-count advice fits a shuffle-reading stage, from the effective conf and the
// stage's own task sizes. The partition count that brings each shuffle partition down to the ideal
// size is per stage; the property is job-wide. 'sufficient': the stage's tasks are already at or
// under the ideal size. 'aqeCoalesced': AQE merged the property's partitions into fewer tasks, so
// the advisory partition size is the lever. 'ownPartitioning': the property already gives at least
// the count needed, so the stage's own repartition(n) or RDD parallelism limits it. Otherwise the
// property limits the stage: 'raise'.
function shufflePartitionCase(stage: DetectorStage, app: DetectorApp | null): { partitions: ShufflePartitions; count: number | null; needed: number } {
  const count = effectiveShufflePartitions(app);
  const needed = Math.ceil(stage.shuffleReadBytes / IDEAL_BYTES_PER_PARTITION_TASK);
  const tasks = Math.max(1, stage.taskCount);
  let partitions: ShufflePartitions = 'raise';
  if (stage.shuffleReadBytes / tasks <= IDEAL_BYTES_PER_PARTITION_TASK) partitions = 'sufficient';
  else if (count != null && stage.taskCount < count
    && loggedAs(app, 'spark.sql.adaptive.enabled', true) && loggedAs(app, 'spark.sql.adaptive.coalescePartitions.enabled', true)) partitions = 'aqeCoalesced';
  else if (count != null && count >= needed) partitions = 'ownPartitioning';
  return { partitions, count, needed };
}

const ADVISORY_PARTITION_SIZE_KEY = 'spark.sql.adaptive.advisoryPartitionSizeInBytes';

// lowShuffleParallelism's fix. Unlike the shuffle finding it fires on stages whose tasks are larger
// than the ideal size, so its cases are 'raise', 'aqeCoalesced' and 'ownPartitioning'.
function lowShuffleParallelismFix(stage: DetectorStage, app: DetectorApp | null): { partitions: ShufflePartitions; text: string; remediation: Remediation[] } {
  const { partitions, count, needed } = shufflePartitionCase(stage, app);
  if (partitions === 'aqeCoalesced') {
    return {
      partitions,
      text: `AQE coalesced the shuffle into ${stage.taskCount} tasks (from ${count} configured partitions): lower ${ADVISORY_PARTITION_SIZE_KEY} so each partition is smaller`,
      remediation: [decreaseConf(ADVISORY_PARTITION_SIZE_KEY)],
    };
  }
  if (partitions === 'ownPartitioning') {
    return {
      partitions,
      text: `spark.sql.shuffle.partitions is already ${count}, so raise this stage's own partition count (its repartition(n) or RDD parallelism) so each partition is smaller`,
      remediation: [],
    };
  }
  return {
    partitions,
    text: 'raise spark.sql.shuffle.partitions so each partition is smaller',
    remediation: [increaseConf('spark.sql.shuffle.partitions', count == null ? null : needed)],
  };
}

// A Spark byte-size property as bytes (a plain number, or with a k/m/g/t suffix, optionally 'b'), or
// null when it is not one. Negative numbers pass through: -1 turns auto-broadcast off.
function parseSparkBytes(value: string | undefined): number | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(value?.trim() ?? '');
  if (m == null) return null;
  return m[2] === '' ? Number(m[1]) : Number(m[1]) * 1024 ** ('kmgt'.indexOf(m[2].toLowerCase()) + 1);
}

// The run's effective spark.sql.autoBroadcastJoinThreshold in bytes (logged, else Spark's 10 MiB);
// negative when auto-broadcast is disabled, null when the logged value is not a size.
function effectiveBroadcastThreshold(app: DetectorApp | null): number | null {
  const raw = effectiveConf(app, 'spark.sql.autoBroadcastJoinThreshold');
  if (raw != null && /^-\d+$/.test(raw)) return -1;
  return parseSparkBytes(raw);
}

// No dynamic-allocation property has an effect on a run whose logged conf turns it off.
function dynamicAllocationOff(app: DetectorApp | null): boolean {
  return app?.resources?.dynamicAllocationEnabled === false || app?.config?.['spark.dynamicAllocation.enabled']?.trim().toLowerCase() === 'false';
}

// Shared by cacheUtilization's two variants, worded per storage source: neither is a runtime
// block-access read-count.
const CACHE_UTILIZATION_VALIDATION = {
  rddInfo: "This ratio is a point-in-time storage snapshot from stage-submission events, not a runtime read-count. Confirm against the Spark UI's Storage tab before acting.",
  blockUpdates: "This ratio is the RDD's peak cache residency rebuilt from block-update events, not a runtime read-count. Confirm against the Spark UI's Storage tab before acting.",
} as const;

// Both cachedRatio and diskRatio are percentages of an RDD's partition/byte count: with few
// partitions, one partition flipping cached/evicted (or disk-resident/memory-resident) swings the
// reported percentage by a large amount, so the point estimate is noisy. More partitions average
// that noise out into a stable ratio. numPartitions is the only sample-size signal
// DetectorRddInfo carries, so it drives confidence for both variants rather than a flat guess.
// 10/50 mirror this file's other "trust the sample" cutoffs (skew's minTasksForP95: 20,
// coreLocality's minTasks: 50).
function cacheSampleConfidence(numPartitions: number): 'low' | 'medium' | 'high' {
  if (numPartitions < 10) return 'low';
  if (numPartitions >= 50) return 'high';
  return 'medium';
}

/** A sentence names a cached RDD by its first 40 characters, since RDD names are often a whole
 * plan string (the Cache Storage card shows it in full); an unnamed RDD reads "RDD <id>". */
function rddLabel({ id, name }: DetectorRddInfo): string {
  return `RDD ${!name ? id : name.length > 40 ? `${name.slice(0, 40)}...` : name}`;
}

function partialCacheFinding(rdd: DetectorRddInfo, cachedRatio: number, impactBand: 'warning' | 'info'): Finding {
  const cachedPct = Math.round(cachedRatio * 100);
  const evictedPct = 100 - cachedPct;
  return {
    type: 'cacheUtilization', variant: 'partialCache', stageId: null,
    rddId: rdd.id, rddName: rdd.name || `RDD ${rdd.id}`,
    impactBand, metric: 'cachedRatio', value: cachedPct,
    confidence: cacheSampleConfidence(rdd.numPartitions),
    validationRequired: CACHE_UTILIZATION_VALIDATION[rdd.storageSource ?? 'rddInfo'],
    memorySize: rdd.memorySize, diskSize: rdd.diskSize,
    numCachedPartitions: rdd.numCachedPartitions, numPartitions: rdd.numPartitions,
    recommendation: `${rddLabel(rdd)} is ${evictedPct}% evicted from cache (${cachedPct}% of partitions cached): increase executor memory or reduce the cached dataset size.`,
    remediation: [increaseConf('spark.executor.memory')],
  };
}

function diskSpilloverFinding(rdd: DetectorRddInfo, diskRatio: number, impactBand: 'warning' | 'info'): Finding {
  const diskPct = Math.round(diskRatio * 100);
  return {
    type: 'cacheUtilization', variant: 'diskSpillover', stageId: null,
    rddId: rdd.id, rddName: rdd.name || `RDD ${rdd.id}`,
    impactBand, metric: 'diskRatio', value: diskPct,
    confidence: cacheSampleConfidence(rdd.numPartitions),
    validationRequired: CACHE_UTILIZATION_VALIDATION[rdd.storageSource ?? 'rddInfo'],
    memorySize: rdd.memorySize, diskSize: rdd.diskSize,
    numCachedPartitions: rdd.numCachedPartitions, numPartitions: rdd.numPartitions,
    recommendation: `${rddLabel(rdd)} is ${diskPct}% spilled to disk despite requesting MEMORY_AND_DISK: executor memory may be too small for it.`,
    remediation: [increaseConf('spark.executor.memory')],
  };
}

// Persisted RDDs with no storage evidence at all: no block updates in the log, and RDD Info's
// sizes are the 0 that Spark 2.3+ always writes. Reports the gap instead of a clean result, the
// same missing-evidence shape as memoryUtilization's dataUnavailable caveat.
function storageUnobservedFinding(persistedRddCount: number, app: DetectorApp | null): Finding {
  const rdds = persistedRddCount === 1 ? '1 persisted RDD has' : `${persistedRddCount} persisted RDDs have`;
  return {
    type: 'cacheUtilization', variant: 'storageUnobserved', stageId: null,
    impactBand: 'info', metric: 'persistedRdds', value: persistedRddCount, dataUnavailable: true,
    recommendation: `${rdds} no cache-storage evidence in this log, so eviction and disk spillover can't be checked: Spark 2.3+ records cached sizes only as block updates, which need spark.eventLog.logBlockUpdates.enabled=true.`,
    remediation: setConfUnlessLogged(app, 'spark.eventLog.logBlockUpdates.enabled', true),
  };
}

/** A detector entry's threshold set. number[] too: slowHost's ratioTiers and broadcastSizing's
 * tiers are tier tables its detect() indexes by position. */
export type DetectorThresholds = Readonly<Record<string, number | readonly number[]>>;

export type DetectResult = Finding | Finding[] | null;

// What each scope's detect() is handed. `thresholds` is the entry's own set, or the caller's
// overrides merged over it (analyze()'s `thresholds` option). 'config' has no DetectorCtx:
// auditConfig() runs those entries on the app alone.
interface DetectSignatures<T> {
  stage: (stage: DetectorStage, ctx: DetectorCtx, thresholds: T) => DetectResult;
  sql: (sqlExec: DetectorSqlExec, ctx: DetectorCtx, thresholds: T) => DetectResult;
  app: (ctx: DetectorCtx, thresholds: T) => DetectResult;
  config: (target: DetectorConfigTarget, thresholds: T) => DetectResult;
}

export type DetectorScope = keyof DetectSignatures<never>;

// The same calls with the thresholds already bound: what a runner holds after withThresholds().
interface BoundDetectSignatures {
  stage: (stage: DetectorStage, ctx: DetectorCtx) => DetectResult;
  sql: (sqlExec: DetectorSqlExec, ctx: DetectorCtx) => DetectResult;
  app: (ctx: DetectorCtx) => DetectResult;
  config: (target: DetectorConfigTarget) => DetectResult;
}

// The fields a define*Detector() call spells out. `detect` is a property, not a method, so its
// parameters are checked contravariantly: a detect() that reads a threshold the entry doesn't
// declare, or expects a different target, fails to compile.
interface DetectorSpec<
  S extends DetectorScope, TType extends string, TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, TSuppressor extends string,
> {
  type: TType;
  // Every finding `type` this entry pushes. Usually just its own `type`; broadcastSizing's one
  // plan walk emits underBroadcast/overBroadcast and never its own name. FindingType derives from it.
  emits: TEmits;
  // Display order only (widget sequence, verdict tie-breaks). Evaluation order never matters:
  // cross-detector suppression is the explicit `suppressedBy` below.
  order: number;
  fixEffort: FixEffort;
  version: number;
  docAnchor?: string;
  thresholds: T;
  inScorecard?: boolean;
  property?: string;
  // Another entry's `type`: analyze() drops this entry's finding on any stage that detector
  // flagged in the same run, whichever of the two is declared first.
  suppressedBy?: TSuppressor;
  detect: DetectSignatures<Readonly<T>>[S];
  // The impact estimate for one of this entry's findings, run after suppression; null leaves the
  // finding without one. Lives here so a finding type's waste model sits next to the detection
  // that produced it, reading the same helpers its runtime floor does.
  estimate: (finding: FindingOf<TEmits[number]>, ctx: EstimateCtx) => ImpactEstimate | null;
}

type DefinedDetector<
  S extends DetectorScope, TType extends string, TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, TSuppressor extends string,
> = Omit<DetectorSpec<S, TType, TEmits, T, TSuppressor>, 'thresholds'> & {
  scope: S;
  thresholds: Readonly<T>;
  // detect() with this entry's thresholds bound, overridden per key by `overrides`. Throws on an
  // override key the entry doesn't declare or whose shape differs from the default's.
  withThresholds(overrides?: DetectorThresholds): BoundDetectSignatures[S];
};

/** How runners (analyze(), auditConfig(), the catalog helpers) see any DETECTORS entry: its
 * thresholds type erased and detect() left off, so they reach it only through withThresholds().
 * estimate() takes any Finding here: estimateImpact() only hands an entry the types it emits. */
export type Detector = {
  [S in DetectorScope]: Omit<DefinedDetector<S, string, readonly Finding['type'][], DetectorThresholds, string>, 'detect' | 'estimate'> & {
    estimate(finding: Finding, ctx: EstimateCtx): ImpactEstimate | null;
  };
}[DetectorScope];

// Same-shape overrides merged over the defaults. analyze()'s callers validate overrides at their
// own boundary (threshold-overrides.ts); this re-checks so a programmatic caller can't hand a
// detector a threshold of the wrong shape, which is what makes the cast below sound.
function mergeThresholds<T extends DetectorThresholds>(type: string, defaults: Readonly<T>, overrides: DetectorThresholds): Readonly<T> {
  for (const [name, value] of Object.entries(overrides)) {
    // Own keys only: an inherited name such as `constructor` or `toString` is no threshold.
    if (!Object.hasOwn(defaults, name)) throw new Error(`Detector ${type} has no threshold "${name}".`);
    const fallback = defaults[name];
    const sameShape = Array.isArray(fallback)
      ? Array.isArray(value) && value.length === fallback.length
      : typeof value === 'number';
    if (!sameShape) throw new Error(`Threshold ${type}.${name} must have the same shape as its default.`);
  }
  return Object.freeze({ ...defaults, ...overrides }) as Readonly<T>;
}

function defineDetector<
  S extends DetectorScope, TType extends string, TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, TSuppressor extends string,
>(
  scope: S, spec: DetectorSpec<S, TType, TEmits, T, TSuppressor>,
  bind: (thresholds: Readonly<T>) => BoundDetectSignatures[S],
): DefinedDetector<S, TType, TEmits, T, TSuppressor> {
  // Frozen: the defaults are the specification, never a knob to mutate in place.
  const defaults = Object.freeze({ ...spec.thresholds }) as Readonly<T>;
  const boundDefaults = bind(defaults);
  return {
    ...spec, scope, thresholds: defaults,
    withThresholds: (overrides) => (overrides && Object.keys(overrides).length > 0
      ? bind(mergeThresholds(spec.type, defaults, overrides))
      : boundDefaults),
  };
}

// One helper per scope: each infers the entry's thresholds type from its `thresholds` literal
// and hands detect() exactly that type, with the scope's target and a required context.
export function defineStageDetector<
  const TType extends string, const TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, const TSuppressor extends string = never,
>(spec: DetectorSpec<'stage', TType, TEmits, T, TSuppressor>) {
  return defineDetector('stage', spec, (t) => (stage, ctx) => spec.detect(stage, ctx, t));
}

export function defineSqlDetector<
  const TType extends string, const TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, const TSuppressor extends string = never,
>(spec: DetectorSpec<'sql', TType, TEmits, T, TSuppressor>) {
  return defineDetector('sql', spec, (t) => (sqlExec, ctx) => spec.detect(sqlExec, ctx, t));
}

export function defineAppDetector<
  const TType extends string, const TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, const TSuppressor extends string = never,
>(spec: DetectorSpec<'app', TType, TEmits, T, TSuppressor>) {
  return defineDetector('app', spec, (t) => (ctx) => spec.detect(ctx, t));
}

export function defineConfigDetector<
  const TType extends string, const TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, const TSuppressor extends string = never,
>(spec: DetectorSpec<'config', TType, TEmits, T, TSuppressor>) {
  return defineDetector('config', spec, (t) => (target) => spec.detect(target, t));
}

// Threshold field naming convention:
// *Pct = 0–1 fraction (normalized)
// *Pct100 = 0–100 scale
// *Ratio = multiplicative factor
// *Share/*Rate/*Util = 0–1 fraction (normalized)

// A ratio just past ratioWarn is the case most likely to be ordinary task-duration variance
// rather than real skew; a ratio many multiples past it (a 50x P95/median vs. a 3.1x one) is
// unambiguous. 1.5x/5x mirror this file's other "just past the floor vs. clearly past it" splits
// (duplicateSubtreeConfidence's 2x, cacheSampleConfidence's 10/50-partition cutoffs).
function skewConfidence(ratio: number, ratioWarn: number): 'low' | 'medium' | 'high' {
  if (ratio <= ratioWarn * 1.5) return 'low';
  if (ratio >= ratioWarn * 5) return 'high';
  return 'medium';
}

// warnPct100/lowInfoPct100 are this detector's own two thresholds; scale confidence as a multiple
// of whichever one gates the branch that fired, the same way skewConfidence scales off ratioWarn.
// High-GC: a pct just past warnPct100 (10%) is likely normal variance, 3x past it is unambiguous.
// Low-GC ("cost", over-provisioned): a pct just under lowInfoPct100 (5%) is borderline, a pct near
// zero is unambiguous idle GC.
function gcConfidence(
  pct: number,
  thresholds: { warnPct100: number; lowInfoPct100: number },
  direction: 'high' | 'low',
): 'low' | 'medium' | 'high' {
  if (direction === 'high') {
    if (pct <= thresholds.warnPct100 * 1.5) return 'low';
    if (pct >= thresholds.warnPct100 * 3) return 'high';
    return 'medium';
  }
  if (pct >= thresholds.lowInfoPct100 * 0.66) return 'low';
  if (pct <= thresholds.lowInfoPct100 * 0.2) return 'high';
  return 'medium';
}

// warnFloor gates the finding, so a value just past it is the weakest evidence this detector can
// produce. highFloor is critPct: straggler's own second (speculative-share) tier, 2x warnPct
// (0.10 -> 0.20); reused as the high-confidence bar for the stragglerShare path too since that
// metric has no dedicated critical tier of its own (see the "no dedicated critical tier" comment
// on the straggler detector) but is the same 0-1 task-share magnitude.
function stragglerConfidence(shareValue: number, warnFloor: number, highFloor: number): 'low' | 'medium' | 'high' {
  if (shareValue < warnFloor * 1.5) return 'low';
  if (shareValue >= highFloor) return 'high';
  return 'medium';
}

// minWasteMs is speculationWaste's own floor; a run that barely clears it (under 1.5x) is the
// weakest case, one that clears it several times over (4x, i.e. 4 minutes against a 1-minute
// floor) is unambiguous.
function speculationWasteConfidence(wastedMs: number, minWasteMs: number): 'low' | 'medium' | 'high' {
  if (wastedMs <= minWasteMs * 1.5) return 'low';
  if (wastedMs >= minWasteMs * 4) return 'high';
  return 'medium';
}

// The finding already gates on wastedMBSeconds > wasteBufferMultiplier * usedMBSeconds, i.e. a
// ratio of 1 at the floor; scale confidence off that same ratio the way skewConfidence scales off
// ratioWarn, instead of introducing a second, unrelated multiplier.
function memoryWasteConfidence(wastedMBSeconds: number, usedMBSeconds: number, wasteBufferMultiplier: number): 'low' | 'medium' | 'high' {
  const ratio = usedMBSeconds > 0 ? wastedMBSeconds / (wasteBufferMultiplier * usedMBSeconds) : Infinity;
  if (ratio <= 1.5) return 'low';
  if (ratio >= 3) return 'high';
  return 'medium';
}

// Two independent weak spots can each undercut this finding: a ratio just past warnRatio (could
// be one bad stage), or too few sampled tasks (mirrors cacheSampleConfidence's use of
// numPartitions as a sample-size signal). Report whichever signal is weaker rather than
// averaging them away. critRatio is this detector's own existing second tier, reused directly as
// the ratio high-bar; minTasks*2/*4 mirror the same "2x floor is still weak, 4x is strong" spread
// used elsewhere in this file.
function coreLocalityConfidence(
  ratio: number,
  totalTasks: number,
  thresholds: { minTasks: number; warnRatio: number; critRatio: number },
): 'low' | 'medium' | 'high' {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const ratioTier = ratio < thresholds.warnRatio * 1.5 ? 'low' : ratio >= thresholds.critRatio ? 'high' : 'medium';
  const sampleTier = totalTasks < thresholds.minTasks * 2 ? 'low' : totalTasks >= thresholds.minTasks * 4 ? 'high' : 'medium';
  return rank[ratioTier] <= rank[sampleTier] ? ratioTier : sampleTier;
}

// warningPct/criticalPct are this detector's own two tiers (0.30/0.60); a churn rate just past
// warningPct is the borderline call the impact-band split already treats as the weaker tier, so
// reuse criticalPct directly as the high-confidence bar instead of inventing a third figure.
function autoscalingChurnConfidence(shortLivedPct: number, warningPct: number, criticalPct: number): 'low' | 'medium' | 'high' {
  if (shortLivedPct <= warningPct * 1.5) return 'low';
  if (shortLivedPct >= criticalPct) return 'high';
  return 'medium';
}

// minExecutions is the bare minimum occurrence count this detector will even emit a finding for;
// a match at exactly that count is the weakest reuse signal (as likely to be coincidental overlap
// as real shared work), while 3x the floor is several independent executions all hitting the same
// relation/composite shape, unambiguous. Mirrors duplicateSubtreeConfidence's occurrences handling
// for the same reason: repetition count is the strength signal for a structural-match detector.
function cachingReuseConfidence(occurrences: number, minExecutions: number): 'low' | 'medium' | 'high' {
  if (occurrences <= minExecutions) return 'low';
  if (occurrences >= minExecutions * 3) return 'high';
  return 'medium';
}

// Caveats that name a threshold read it from the thresholds the detector ran with, so a tuned run
// states the floor it actually used.
function gcValidation(minRunTimeMs: number): string {
  return `Checked only on stages with at least ${minRunTimeMs / 1000}s of executor run time.`;
}

const INCOMPLETE_RUN_RECOMMENDATION = 'This event log never recorded an ApplicationEnd event: the capture stopped before the run finished (a job still running, a rotated log, or a cut-short capture), so every figure on this board covers only what was captured.';

export const DETECTORS = [
  defineStageDetector({
    type: 'skew', order: 30, fixEffort: 'code', version: 1,
    emits: ['skew'],
    docAnchor: '#bottleneck-skew',
    thresholds: { ratioWarn: 3, minTasksForP95: 20, floorPctWarn: IMPACT_FLOOR_PCT_WARN },
    detect(stage, ctx, thresholds): Finding | null {
      const result = computeSkewRatio(stage, thresholds.minTasksForP95);
      if (result === null) return null;
      const { ratio, metric } = result;
      if (ratio <= thresholds.ratioWarn) return null;
      // The claim estimate() reports as savings, clipped the same way, so the gate agrees with it.
      const floorWasteMs = tailClaimFloorMs(skewTailClaim(stage, metric === 'P95/median'), stage.id, ctx);
      if (!meetsRuntimeFloor(floorWasteMs, appDurationMs(ctx.app), thresholds.floorPctWarn)) return null;
      const value = Math.round(ratio * 10) / 10;
      const fix = skewFix(stage, ctx);
      return {
        type: 'skew', stageId: stage.id, origin: fix.origin,
        impactBand: 'warning',
        metric, value,
        confidence: skewConfidence(ratio, thresholds.ratioWarn),
        validationRequired: `Flagged only when it costs at least ${shareLabel(thresholds.floorPctWarn)} of run time.`,
        recommendation: `Task duration ratio (${metric}) is ${value}×: ${fix.text}.`,
        remediation: fix.remediation,
      };
    },
    estimate(finding, ctx): ImpactEstimate | null {
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      // computeSkewRatio's own metric labels: 'P95/median' or 'max/median'.
      return tailClaimImpact(skewTailClaim(stage, finding.metric === 'P95/median'), finding.stageId, ctx);
    },
  }),
  defineStageDetector({
    type: 'stageShape', order: 35, fixEffort: 'code', version: 2,
    emits: ['stageShape'],
    docAnchor: '#bottleneck-stage-shape',
    // lowParallelismFloorPct: the same 0.5% runtime floor the tiered detectors use. Parallelizing a
    // stage can't save more than the stage's own duration, so a shorter stage can't clear it; on
    // the 14 real logs that was 2839 of 3005 lowParallelism findings (2168 on sub-second stages).
    // App-wide idle capacity stays covered by utilization.
    // taskStageSkew: stageShareMin is the share of the stage's wall-clock the longest task must
    // span, and skewWarn how far past the median task it must run (skew's own max/median 3×).
    // The share alone can't tell a straggler apart: on a single wave (tasks <= cores) the longest
    // task spans nearly the whole stage however even the tasks are. taskStageSkewFloorPct is the
    // same 0.5% runtime floor as lowParallelismFloorPct.
    thresholds: {
      pRatioMax: 0.5, oiRatioMax: 10, skewWarn: 3, stageShareMin: 0.5,
      lowParallelismFloorPct: 0.005, taskStageSkewFloorPct: 0.005,
    },
    detect(stage, ctx, thresholds): Finding[] {
      const out: Finding[] = [];
      const execCount = (stage.executorStats ?? []).length;
      const cores = ctx.app?.resources?.executor?.cores ?? 1;
      const totalCores = execCount * cores;
      const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
      // PRatio: under-parallelization.
      if (totalCores > 0 && !stageBelowRuntimeFloor(stage, ctx, thresholds.lowParallelismFloorPct)) {
        const pRatio = stage.taskCount / totalCores;
        if (pRatio < thresholds.pRatioMax) {
          out.push({
            type: 'stageShape', stageId: stage.id, impactBand: 'info',
            rule: 'lowParallelism', metric: 'pRatio', value: Math.round(pRatio * 100) / 100,
            // Absolute core count behind pRatio, for the impact estimator's idle-core-ms figure.
            totalCores,
            recommendation: `This stage runs ${stage.taskCount} ${stage.taskCount === 1 ? 'task' : 'tasks'} across ~${totalCores} cores: it is under-parallelized and leaves cluster capacity idle.`,
          });
        }
      }
      // OIRatio: data explosion. Skip when inputBytes is 0 (Infinity guard).
      if (stage.inputBytes > 0) {
        const oiRatio = stage.outputBytes / stage.inputBytes;
        if (oiRatio > thresholds.oiRatioMax) {
          out.push({
            type: 'stageShape', stageId: stage.id, impactBand: 'info',
            rule: 'dataExplosion', metric: 'oiRatio', value: Math.round(oiRatio * 10) / 10,
            recommendation: `This stage outputs ${Math.round(oiRatio)}× its input volume: check for an exploding join or a cross product.`,
          });
        }
      }
      // TaskStageSkew: one straggler sets when the stage ends. A task runs inside its stage's
      // window, so the longest task's share of the stage's wall-clock is at most 1. Skip a
      // zero-length or single-task stage. Always info like its siblings: skew and straggler
      // already make the wall-clock claim for the same tail, so this one reports idle core-time.
      if (stageDurationMs > 0 && stage.taskCount > 1 && stage.taskDurationP50 > 0
        && !stageBelowRuntimeFloor(stage, ctx, thresholds.taskStageSkewFloorPct)) {
        const share = stage.taskDurationMax / stageDurationMs;
        const vsMedian = stage.taskDurationMax / stage.taskDurationP50;
        if (share > thresholds.stageShareMin && vsMedian > thresholds.skewWarn) {
          out.push({
            type: 'stageShape', stageId: stage.id, impactBand: 'info',
            rule: 'taskStageSkew', metric: 'taskStageSkew', value: Math.round(share * 100) / 100,
            // Absolute core count, for the impact estimator's idle-core-ms figure.
            totalCores,
            recommendation: `The longest task ran for ${Math.round(share * 100)}% of this stage's wall-clock, ${Math.round(vsMedian * 10) / 10}× the median task: a single straggler is gating the whole stage.`,
          });
        }
      }
      return out;
    },
    estimate(finding, ctx): ImpactEstimate | null {
      const stage = ctx.stages.get(finding.stageId as number);
      if (!stage) return null;
      if (finding.rule === 'lowParallelism') {
        const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
        const idleCoreMs =
          Math.max(0, ((finding.totalCores as number | undefined) ?? 0) - (stage.taskCount ?? 0)) * stageDurationMs;
        // Real per-stage data (cores, task count, duration), no assumed constant.
        return costOnly('measured', { value: idleCoreMs, unit: 'coreMs', idle: true });
      }
      if (finding.rule === 'dataExplosion') {
        const excessBytes = Math.max(0, (stage.outputBytes ?? 0) - (stage.inputBytes ?? 0));
        // Measured input/output byte counts, no assumed constant.
        return costOnly('measured', { value: excessBytes, unit: 'bytes' });
      }
      if (finding.rule === 'taskStageSkew') {
        const totalCores = (finding.totalCores as number | undefined) ?? 0;
        const taskCount = stage.taskCount ?? 0;
        // Cores idle during the straggler's tail, at achieved concurrency (not full cluster
        // capacity, which is lowParallelism's territory): resourceOnly, since skew and straggler
        // already claim that tail's wall-clock time.
        const idleCoreMs =
          Math.max(0, Math.min(totalCores, taskCount) - 1) *
          Math.max(0, (stage.taskDurationMax ?? 0) - (stage.taskDurationP50 ?? 0));
        return costOnly('measured', { value: idleCoreMs, unit: 'coreMs', idle: true });
      }
      return null;
    },
  }),
  defineStageDetector({
    type: 'shuffle', order: 20, fixEffort: 'config', version: 1,
    emits: ['shuffle'],
    docAnchor: '#bottleneck-shuffle',
    // stageFloorPct: the 0.5% runtime floor. The shuffle claim is clipped to the stage, so on a
    // shorter stage it graded info: 182 of 284 shuffle findings on the 14 real logs. The shuffle
    // is still there on those stages; the floor is why they're dropped.
    thresholds: { minBytes: 50 * MB, stageFloorPct: 0.005 },
    detect(stage, ctx, thresholds): Finding | null {
      const bytes = stage.shuffleReadBytes;
      if (bytes <= thresholds.minBytes) return null;
      if (stageBelowRuntimeFloor(stage, ctx, thresholds.stageFloorPct)) return null;
      const { partitions, count } = shufflePartitionCase(stage, ctx.app);
      const perTask = formatBytes(bytes / Math.max(1, stage.taskCount));
      const fix = partitions === 'sufficient'
        ? { text: `its ${stage.taskCount} tasks already read about ${perTask} each, so more partitions will not help: consider a broadcast join for the smaller side`, remediation: [] }
        : partitions === 'aqeCoalesced'
          ? { text: `AQE coalesced it into ${stage.taskCount} tasks (from ${count} configured partitions): consider lowering ${ADVISORY_PARTITION_SIZE_KEY} or adding a broadcast join`, remediation: [decreaseConf(ADVISORY_PARTITION_SIZE_KEY)] }
          : partitions === 'ownPartitioning'
            ? { text: `spark.sql.shuffle.partitions is already ${count}, so consider raising this stage's own partition count (its repartition(n) or RDD parallelism) or adding a broadcast join`, remediation: [] }
            : { text: 'consider increasing spark.sql.shuffle.partitions or adding a broadcast join', remediation: [increaseConf('spark.sql.shuffle.partitions')] };
      return {
        type: 'shuffle', stageId: stage.id,
        impactBand: 'info', partitions,
        metric: 'shuffleReadBytes', value: bytes,
        recommendation: `${formatBytes(bytes)} shuffled in this stage: ${fix.text}.`,
        remediation: fix.remediation,
      };
    },
    estimate(finding, ctx): ImpactEstimate | null {
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      const shuffleReadBytes = stage.shuffleReadBytes ?? 0;
      const modeledMs = (shuffleReadBytes / (SHUFFLE_THROUGHPUT_BPS * stageIoParallelism(stage))) * 1000;
      // The link model can't see whether the reads stalled the tasks: capped at the fetch wait the
      // tasks measured, the claim never exceeds what the stage spent blocked on the network.
      const measuredMs = fetchWaitWallClockMs(stage);
      const wasteMs = measuredMs == null ? modeledMs : Math.min(modeledMs, measuredMs);
      // rawWaste: the measured byte volume behind the modeled figure.
      return singleStageImpact(wasteMs, finding.stageId, ctx,
        measuredMs != null && measuredMs < modeledMs ? 'measured' : 'modeled', { value: shuffleReadBytes, unit: 'bytes' });
    },
  }),
  defineStageDetector({
    type: 'partitionSizing', order: 22, fixEffort: 'config', version: 1,
    emits: ['partitionSizing'],
    docAnchor: '#bottleneck-partition-sizing',
    thresholds: { skewRatio: 5, skewFloorBytes: 256 * MB, lowParTotalBytes: GB, lowParMaxTasks: 7, maxPartBytes: 5 * GB },
    detect(stage, ctx, thresholds): Finding[] {
      const out: Finding[] = [];
      const { shuffleReadP50: p50, shuffleReadMax: max, shuffleReadBytes: total, taskCount } = stage;
      if (max > thresholds.skewRatio * p50 && max > thresholds.skewFloorBytes) {
        // p50 can be 0 (over half the shuffle partitions empty): a ratio against zero renders
        // "Infinity×", so fall back to median-free phrasing.
        const ratioText = p50 > 0
          ? `${Math.round(max / p50 * 10) / 10}× the median (${formatBytes(p50)})`
          : 'far larger than the median, which is effectively empty';
        const fix = skewFix(stage, ctx, true);
        out.push({
          type: 'partitionSizing', stageId: stage.id, impactBand: 'warning',
          rule: 'shufflePartitionSkew', origin: fix.origin, metric: 'shuffleReadMax', value: max,
          recommendation: `The largest shuffle partition (${formatBytes(max)}) is ${ratioText}: ${fix.text}.`,
          remediation: fix.remediation,
        });
      }
      if (total >= thresholds.lowParTotalBytes && taskCount <= thresholds.lowParMaxTasks) {
        const fix = lowShuffleParallelismFix(stage, ctx.app);
        out.push({
          type: 'partitionSizing', stageId: stage.id, impactBand: 'warning',
          rule: 'lowShuffleParallelism', partitions: fix.partitions, metric: 'taskCount', value: taskCount,
          recommendation: `${Math.round(total / GB * 10) / 10} GB of shuffle spread over only ${taskCount} tasks: ${fix.text}.`,
          remediation: fix.remediation,
        });
      }
      if (max >= thresholds.maxPartBytes) {
        // Fixed 'critical': an OOM/crash-risk safety signal, not a time-waste one. Exempted in
        // impact-band.ts's deriveImpactBand from the wall-clock-based overwrite every other
        // finding here gets, so a long-running job can't demote an active crash risk to 'info'
        // just because the modeled time savings are a small fraction of total runtime.
        out.push({
          type: 'partitionSizing', stageId: stage.id, impactBand: 'critical',
          rule: 'maxPartitionTooBig', metric: 'shuffleReadMax', value: max,
          recommendation: `A single shuffle partition (${formatBytes(max)}) exceeds 5 GB: this will OOM or spill heavily. Repartition to break it up before this stage.`,
        });
      }
      return out;
    },
    estimate(finding, ctx): ImpactEstimate | null {
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      let wasteMs = 0;
      let longestTaskAfterFixMs = 0;
      if (finding.rule === 'maxPartitionTooBig') {
        wasteMs = ((stage.shuffleReadMax ?? 0) / SHUFFLE_THROUGHPUT_BPS) * 1000;
      } else if (finding.rule === 'shufflePartitionSkew') {
        const delta = Math.max(0, (stage.shuffleReadMax ?? 0) - (stage.shuffleReadP50 ?? 0));
        wasteMs = (delta / SHUFFLE_THROUGHPUT_BPS) * 1000;
      } else if (finding.rule === 'lowShuffleParallelism') {
        const targetTaskCount = Math.ceil((stage.shuffleReadBytes ?? 0) / IDEAL_BYTES_PER_PARTITION_TASK);
        const taskCount = stage.taskCount ?? 0;
        if (targetTaskCount > taskCount && taskCount > 0) {
          const stageDurationMs = Math.max(0, (stage.completedAt ?? 0) - (stage.submittedAt ?? 0));
          // Too few shuffle partitions means each task processes more than the ideal bytes,
          // serializing work more partitions would run concurrently: the waste is that serialized
          // work, not the scheduling cost of tasks you'd add (adding tasks incurs overhead, recovers
          // nothing). Model the achievable duration at target parallelism by scaling down proportionally.
          wasteMs = stageDurationMs * (1 - taskCount / targetTaskCount);
          // The fix splits the long tasks, so the longest task is the quantity it shortens: the
          // occupancy clip must not floor the claim at it (TAIL_CLAIM). An even split leaves the
          // longest task at taskCount / targetTaskCount of today's: a modeled figure.
          const longestTaskMs = stage.taskDurationMax ?? 0;
          longestTaskAfterFixMs = longestTaskMs * taskCount / targetTaskCount;
          // Splitting only shortens tasks: the stage still takes the time outside its longest task
          // plus the longest task the split leaves, so the claim is at most the longest task's own
          // reduction. Without a task-duration max (older snapshots) the stage-wide scaling stands.
          if (longestTaskMs > 0) wasteMs = Math.min(wasteMs, longestTaskMs - longestTaskAfterFixMs);
        }
      } else {
        return null;
      }
      return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', { value: wasteMs, unit: 'ms' },
        finding.rule === 'lowShuffleParallelism' ? { ...TAIL_CLAIM, longestTaskAfterFixMs } : undefined);
    },
  }),
  defineStageDetector({
    type: 'spill', order: 10, fixEffort: 'code', version: 1,
    emits: ['spill'],
    docAnchor: '#bottleneck-spill',
    // stageFloorPct: the 0.5% runtime floor, as for shuffle (12 of 38 spill findings on the 14 real
    // logs, all info). The spill is still there on those stages; the floor is why they're dropped.
    thresholds: { singleTaskDiskGiB: 1, singleTaskMemGiB: 4, highDiskGiB: 1, highTaskDiskMB: 512, highMemGiB: 4, medDiskMB: 256, medMemGiB: 1, skewRatio: 5, skewDiskFloorMB: 128, skewMemFloorMB: 256, skewMinTasks: 10, stageFloorPct: 0.005 },
    detect(stage, ctx, thresholds): Finding | null {
      if (stage.memoryBytesSpilled === 0) return null;
      if (stageBelowRuntimeFloor(stage, ctx, thresholds.stageFloorPct)) return null;
      const cls = stage.spillClassification;
      const classified = cls === 'skew' || cls === 'volume';
      const mag = computeSpillMagnitude(stage, thresholds);
      const impactBand = 'warning';
      // shuffle.partitions sizes a shuffle's reduce side: a stage that reads no shuffle gets memory only.
      const reads = stageReads(stage);
      const partitionAdvice = reads === 'shuffle';
      return {
        type: 'spill', stageId: stage.id, impactBand, reads,
        spillMagnitude: mag?.magnitude,
        metric: 'memoryBytesSpilled', value: stage.memoryBytesSpilled,
        confidence: classified ? 'medium' : 'low',
        validationRequired: classified
          ? 'Spill cause is inferred from the share of tasks that spilled: confirm against per-task spill metrics in the Spark UI.'
          : 'Spill cause could not be classified: inspect per-task spill metrics in the Spark UI before acting.',
        recommendation: cls === 'skew'
          ? `${formatBytes(stage.memoryBytesSpilled)} spilled, skew-driven: fix task skew first; adding memory will not help.`
          : partitionAdvice
            ? `${formatBytes(stage.memoryBytesSpilled)} spilled: raise spark.sql.shuffle.partitions or increase executor memory.`
            : `${formatBytes(stage.memoryBytesSpilled)} spilled: this stage reads no shuffle, so increase executor memory or process less data per task.`,
        remediation: cls === 'skew' ? [] : [...(partitionAdvice ? [increaseConf('spark.sql.shuffle.partitions')] : []), increaseConf('spark.executor.memory')],
      };
    },
    estimate(finding, ctx): ImpactEstimate | null {
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      const diskBytesSpilled = stage.diskBytesSpilled ?? 0;
      const wasteMs = (diskBytesSpilled / (SPILL_IO_THROUGHPUT_BPS * stageIoParallelism(stage))) * 1000;
      // Surfaces the number the formula uses: the displayed metric is memoryBytesSpilled, but disk spill costs the I/O time.
      return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', { value: diskBytesSpilled, unit: 'bytes' });
    },
  }),
  defineStageDetector({
    type: 'gc', order: 50, fixEffort: 'config', version: 1,
    emits: ['gc'],
    docAnchor: '#bottleneck-gc',
    thresholds: {
      warnPct100: 10,
      // Descending tier: ExecutorGcHeuristic, ported as-is.
      lowInfoPct100: 5,
      // NOT SOURCED: our own noise floor so a stage that barely ran doesn't flag either direction.
      minRunTimeMs: 10000,
      // lowInfoFloorPct: the 0.5% runtime floor stageShape's lowParallelism uses. The low-GC note is
      // an app-level memory-sizing signal; on a stage shorter than this share of the run it adds
      // nothing to that call. On the 14 real logs that was 464 of 685 low-GC notes (of 701 gc
      // findings); the low-GC pattern is still true on those stages, the floor is why they're dropped.
      lowInfoFloorPct: 0.005,
    },
    detect(stage, ctx, thresholds): Finding | null {
      const pct = stage.gcPct;
      if ((stage.executorRunTime ?? 0) >= thresholds.minRunTimeMs
          && pct > thresholds.warnPct100) {
        const value = Math.round(pct * 10) / 10;
        return {
          type: 'gc', stageId: stage.id,
          impactBand: 'warning',
          metric: 'gcPct', value,
          confidence: gcConfidence(pct, thresholds, 'high'), validationRequired: gcValidation(thresholds.minRunTimeMs),
          recommendation: `GC consumed ${value}% of executor run time: reduce object creation, use primitive types, avoid UDFs, increase executor memory.`,
          remediation: [increaseConf('spark.executor.memory')],
        };
      }
      // Low-GC (cost) branch: only for stages that ran long enough to be meaningful.
      if ((stage.executorRunTime ?? 0) >= thresholds.minRunTimeMs
          && pct < thresholds.lowInfoPct100
          && !stageBelowRuntimeFloor(stage, ctx, thresholds.lowInfoFloorPct)) {
        const value = Math.round(pct * 10) / 10;
        return {
          type: 'gc', stageId: stage.id, direction: 'low',
          impactBand: 'info',
          metric: 'gcPct', value,
          confidence: gcConfidence(pct, thresholds, 'low'), validationRequired: gcValidation(thresholds.minRunTimeMs),
          recommendation: `GC consumed only ${value}% of executor run time: memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.`,
          remediation: [decreaseConf('spark.executor.memory')],
        };
      }
      return null;
    },
    estimate(finding, ctx): ImpactEstimate | null {
      // The low-GC branch is an over-provisioning signal whose fix (less executor memory) raises
      // GC rather than recovering it: the stage's GC time is no saving there, so no waste model.
      if (finding.direction === 'low') return costOnly('none');
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
      const executorRunTime = stage.executorRunTime ?? 0;
      const jvmGCTime = stage.jvmGCTime ?? 0;
      // The raw cross-task core-time sum, before any conversion: the one figure here
      // that is straight from the log rather than modeled.
      const rawWaste = { value: jvmGCTime, unit: 'coreMs' } as const;
      if (executorRunTime <= 0 || stageDurationMs <= 0) {
        return costOnly('modeled', rawWaste);
      }
      const avgConcurrency = executorRunTime / stageDurationMs;
      // jvmGCTime is a cross-task core-time sum (same shape as executorRunTime); dividing by the
      // stage's average concurrency converts it to an approximate wall-clock figure. Modeled, not exact.
      const wasteMs = jvmGCTime / avgConcurrency;
      return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', rawWaste);
    },
  }),
  defineStageDetector({
    type: 'slowHost', order: 60, fixEffort: 'config', version: 1,
    emits: ['slowHost'],
    docAnchor: '#bottleneck-slow-host',
    thresholds: {
      minHosts: 3, minTasks: 15, ratioWarn: 2.0, minShare: 0.20, shareWarn: 0.75, taskShareWarn: 0.50, ratioTiers: [1.33, 1.78, 3.16, 10],
      // Absolute-magnitude floors (mirrors computeSpillMagnitude's ratio+floor pattern): on short
      // stages, sub-second/sub-64MB host differences produce huge noise ratios. 1s is above
      // per-task jitter but below genuine slow-host stages; 64MB mirrors the spill disk-skew floor.
      floorMs: 1000, floorBytes: 64 * MB,
      // stageFloorPct: the tiered detectors' 0.5% runtime floor. On a stage shorter than this share
      // of the run a slow host can't cost that much: duration findings are clipped to the stage
      // and graded info, and a byte-dimension imbalance (no time estimate, so its ratio tier was
      // its band) was graded info here since 6298149. So the stage is skipped: on the 14 real logs
      // 324 of 452 slowHost findings, all info. The imbalance is still there on those stages; the
      // floor is why they're dropped.
      stageFloorPct: 0.005,
    },
    detect(stage, ctx, thresholds): Finding[] | null {
      const hosts = stage.hostStats ?? [];
      const execs0 = stage.executorStats ?? [];
      if ((hosts.length < thresholds.minHosts && execs0.length < thresholds.minHosts) || stage.taskCount < thresholds.minTasks) return null;
      if (stageBelowRuntimeFloor(stage, ctx, thresholds.stageFloorPct)) return null;
      const out: Finding[] = [];
      const speculation = switchFix(loggedAs(ctx.app, 'spark.speculation', true), 'spark.speculation', true,
        'check what it was running, and consider enabling spark.speculation to relaunch a lagging task automatically',
        'check what it was running; speculation is already on, so a lagging task there is already relaunched');
      if (hosts.length >= thresholds.minHosts) {
        const means = hosts.map(h => ({ host: h.host, taskCount: h.taskCount, mean: h.totalDuration / h.taskCount }));
        const sorted = [...means].map(h => h.mean).sort((a, b) => a - b);
        const overallMedian = medianOfSorted(sorted);
        if (overallMedian > 0) {
          for (const h of means) {
            const ratio = h.mean / overallMedian;
            const share = h.taskCount / stage.taskCount;
            if (ratio < thresholds.ratioWarn || share < thresholds.minShare || h.mean < thresholds.floorMs) continue;
            out.push({
              type: 'slowHost', stageId: stage.id,
              impactBand: 'warning',
              metric: 'hostMeanRatio', value: Math.round(ratio * 10) / 10,
              // `value` is a ratio; the estimator needs the absolute per-host mean.
              hostMeanMs: h.mean,
              host: h.host, hostTaskShare: Math.round(share * 100) / 100,
              recommendation: `${h.host} may just hold data locality for its tasks or carry one heavy stage, not necessarily a hardware fault: ${speculation.text}.`,
              remediation: speculation.remediation,
            });
          }
        }
        const totalDuration = hosts.reduce((s, h) => s + h.totalDuration, 0);
        if (totalDuration > 0) {
          for (const h of hosts) {
            const durationShare = h.totalDuration / totalDuration;
            const taskShare = h.taskCount / stage.taskCount;
            if (durationShare >= thresholds.shareWarn && taskShare >= thresholds.taskShareWarn) {
              out.push({
                type: 'slowHost', stageId: stage.id, impactBand: 'warning',
                variant: 'durationShare',
                metric: 'hostDurationShare', value: Math.round(durationShare * 100) / 100,
                // `value` is a 0-1 share; the estimator needs the absolute per-host mean.
                hostMeanMs: h.totalDuration / h.taskCount,
                host: h.host, hostTaskShare: Math.round(taskShare * 100) / 100,
                recommendation: `${h.host} is doing ${Math.round(durationShare * 100)}% of this stage's total task time: check for data locality or partition assignment skewing work onto one node.`,
              });
            }
          }
        }
      }
      const execs = stage.executorStats ?? [];
      const tiers = thresholds.ratioTiers;
      const impactBandFor = (r: number): 'critical' | 'warning' | 'info' | null =>
        r >= tiers[3] ? 'critical' : (r >= tiers[1] ? 'warning' : (r >= tiers[0] ? 'info' : null));
      const floorMs = thresholds.floorMs, floorBytes = thresholds.floorBytes;
      const dims: { dimension: NonNullable<SlowHostFinding['dimension']>; floor: number; samples: { key: string; value: number }[] }[] = [
        { dimension: 'taskTime', floor: floorMs, samples: execs.filter(e => e.taskCount > 0).map(e => ({ key: e.executorId, value: e.totalDuration / e.taskCount })) },
        { dimension: 'inputBytes', floor: floorBytes, samples: execs.map(e => ({ key: e.executorId, value: e.inputBytes ?? 0 })) },
        { dimension: 'shuffleBytes', floor: floorBytes, samples: execs.map(e => ({ key: e.executorId, value: (e.shuffleReadBytes ?? 0) + (e.shuffleWriteBytes ?? 0) })) },
      ];
      // Storage-memory dimension: best-effort, only when executorMetrics present.
      const em = stage.executorMetrics instanceof Map ? stage.executorMetrics : null;
      if (em && em.size >= 3) {
        dims.push({ dimension: 'storageMemory', floor: floorBytes, samples: [...em.entries()].map(([id, m]) => ({ key: id, value: (m.onHeapStorageMemory ?? 0) + (m.offHeapStorageMemory ?? 0) })) });
      }
      for (const d of dims) {
        const r = maxMedianRatio(d.samples);
        if (!r || r.value < d.floor) continue; // absolute-magnitude floor: same ratio+floor shape as computeSpillMagnitude
        const tier = impactBandFor(r.ratio);
        if (!tier) continue;
        // taskTime is the only wallClock-bearing dimension here: fixed fallback
        // (its current floor case), overwritten by deriveImpactBand whenever this
        // finding gets a real wallClock estimate. The other three dimensions never
        // get a wallClock estimate, so they keep the dynamic tier unchanged.
        const impactBand = d.dimension === 'taskTime' ? 'info' : tier;
        out.push({
          type: 'slowHost', stageId: stage.id, impactBand,
          variant: 'multiDim', dimension: d.dimension,
          metric: 'execMaxMedianRatio', value: Math.round(r.ratio * 10) / 10,
          // `value` is a ratio; `execMaxValue` is the deviating sample's raw magnitude
          // in this dimension's own unit (ms for taskTime, bytes for the rest).
          execMaxValue: r.value,
          executorId: r.key,
          recommendation: `Executor ${r.key}'s ${SLOW_HOST_DIMENSION_LABEL[d.dimension]} is ${Math.round(r.ratio * 10) / 10}× the median: investigate uneven partition assignment or a degraded executor.`,
        });
      }
      return out;
    },
    estimate(finding, ctx): ImpactEstimate | null {
      // Three duration-based shapes, each carrying its absolute-ms figure under a different field
      // (`value` is always a ratio/share, never ms): the per-host mean branch (discriminated by
      // `metric`), the duration-share branch (`variant`), and the multiDim taskTime dimension. Every
      // byte-based multiDim dimension has no absolute figure today, so it stays informational.
      const absoluteMs =
        finding.metric === 'hostMeanRatio' || finding.variant === 'durationShare'
          ? (finding.hostMeanMs as number | undefined)
          : finding.variant === 'multiDim' && finding.dimension === 'taskTime'
            ? (finding.execMaxValue as number | undefined)
            : null;
      if (absoluteMs == null) {
        return costOnly('none'); // byte-based multiDim dims: no absolute figure today, no model applied
      }
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      const wasteMs = Math.max(0, absoluteMs - (stage.taskDurationP50 ?? 0));
      return singleStageImpact(wasteMs, finding.stageId, ctx, 'measured', { value: wasteMs, unit: 'ms' });
    },
  }),
  defineStageDetector({
    type: 'stageSlowness', order: 65, fixEffort: 'code', version: 2,
    emits: ['stageSlowness'],
    docAnchor: '#bottleneck-stage-slowness',
    thresholds: { infoMin: 15 },
    // A stage slowHost already explains needs no generic "this stage is slow" finding on top.
    suppressedBy: 'slowHost',
    detect(stage, _ctx, thresholds): Finding | null {
      // Basis is real wall-clock stage duration, not per-executor average; the impact-estimator
      // formula reuses this exact stageDurationMs computation.
      const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
      if (!(stageDurationMs > 0)) return null;
      const durationMinutes = stageDurationMs / 60000;
      const t = thresholds;
      const impactBand = durationMinutes >= t.infoMin ? 'info' : null;
      if (!impactBand) return null;
      const value = Math.round(durationMinutes * 10) / 10;
      // shuffle.partitions and default.parallelism size a shuffle's reduce side: a stage that reads
      // no shuffle gets the input-partitioning remedy instead.
      const reads = stageReads(stage);
      const recommendation = reads === 'shuffle'
        ? `This stage ran ${value} minutes with no more specific cause flagged: often a partition-count problem, raise parallelism via spark.sql.shuffle.partitions or spark.default.parallelism, or check for a large per-task data volume driving heavy shuffle and spill.`
        : reads === 'input'
          ? `This stage ran ${value} minutes with no more specific cause flagged and reads mostly input files: often too few or too uneven input partitions, so check input file sizes and lower spark.sql.files.maxPartitionBytes, or look for a large per-task data volume driving heavy spill.`
          : `This stage ran ${value} minutes with no more specific cause flagged and reads neither shuffle nor input files: check what it computes and for a large per-task data volume driving heavy spill.`;
      return {
        type: 'stageSlowness', stageId: stage.id, impactBand,
        metric: 'stageDurationMinutes', value, reads,
        recommendation,
        remediation: reads === 'shuffle'
          ? [increaseConf('spark.sql.shuffle.partitions'), increaseConf('spark.default.parallelism')]
          : reads === 'input' ? [decreaseConf('spark.sql.files.maxPartitionBytes')] : [],
      };
    },
    estimate(finding, ctx): ImpactEstimate | null {
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      // The recommended fix is more partitions, which only helps a stage that ran fewer tasks than
      // the cluster has cores: the time its tasks were running could then spread over up to
      // totalCores (lowShuffleParallelism's shape). Time the stage sat open with no task running
      // is queueing no partition count recovers. Splitting partitions splits the longest task
      // too, hence TAIL_CLAIM's post-fix floor. Unknown cluster size: no defensible figure.
      if (ctx.totalCores <= 0) return costOnly('modeled');
      // A stage that read no input and no shuffle, its tasks idle waiting on an external system,
      // gains nothing from more partitions (a 1-task JDBC count stage open 27 minutes on 5s of CPU
      // was claimed 99% recoverable): claim 0. Stages that read bytes keep their claim.
      const readBytes = (stage.inputBytes ?? 0) + (stage.shuffleReadBytes ?? 0);
      const activeMs = typeof stage.taskActiveMs === 'number'
        ? stage.taskActiveMs
        : Math.max(0, (stage.completedAt ?? 0) - (stage.submittedAt ?? 0));
      const taskCount = stage.taskCount ?? 0;
      const wasteMs = readBytes <= 0 && tasksMostlyIdle(stage, ctx.sql) ? 0 : activeMs * Math.max(0, 1 - taskCount / ctx.totalCores);
      return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', { value: wasteMs, unit: 'ms' }, TAIL_CLAIM);
    },
  }),
  defineStageDetector({
    type: 'stageFailed', order: 42, fixEffort: 'code', version: 1,
    emits: ['stageFailed'],
    docAnchor: '#bottleneck-failures',
    thresholds: {},
    detect(stage): Finding | null {
      if (stage.stageFailureReason == null) return null;
      return {
        type: 'stageFailed', stageId: stage.id, impactBand: 'critical',
        variant: 'stageFailure',
        metric: 'stageFailureReason', valueText: stage.stageFailureReason,
        numTasks: stage.taskCount,
        memoryBytesSpilled: stage.memoryBytesSpilled,
        failedTaskDetails: stage.failedTaskSamples ?? [],
        recommendation: `This stage attempt failed outright. Inspect the driver log for the failure reason and the job that triggered it.`,
      };
    },
    estimate: noWasteModel,
  }),
  defineStageDetector({
    type: 'failures', order: 40, fixEffort: 'code', version: 2,
    emits: ['failures'],
    docAnchor: '#bottleneck-failures',
    thresholds: { minTasks: 10, warnRate: 0.05, critRate: 0.20 },
    detect(stage, _ctx, thresholds): Finding | null {
      if (stage.taskCount < thresholds.minTasks) return null;
      if (!stage.failedTasks) return null;
      const failureRate = stage.failedTasks / stage.taskCount;
      if (failureRate <= thresholds.warnRate) return null;
      const value = Math.round(failureRate * 1000) / 10;
      const dominantReason = pickDominantReason(stage.failureReasons);
      // Groups arrive most frequent first. Name the dominant error from the largest group under the
      // dominant tag, so the error and the tag agree even when one tag splits into many messages.
      const allGroups = stage.failureGroups ?? [];
      const dominantGroup = allGroups.find((g) => g.reason === dominantReason);
      const dominantError = (dominantGroup ? describeTaskFailure(dominantGroup) : null) ?? dominantReason;
      const failureGroups = allGroups.slice(0, MAX_FAILURE_GROUPS);
      const groupedTasks = failureGroups.reduce((sum, g) => sum + g.count, 0);
      return {
        type: 'failures', stageId: stage.id,
        impactBand: failureRate > thresholds.critRate ? 'critical' : 'warning',
        metric: 'failureRate', value,
        failedTasks: stage.failedTasks,
        dominantReason,
        dominantError,
        // One entry per distinct error (tag, class, message, loss reason), each with one bounded
        // stack excerpt; otherFailedTasks counts the failed tasks no shown group covers.
        failureGroups,
        otherFailedTasks: Math.max(0, stage.failedTasks - groupedTasks),
        recommendation: `${value}% of tasks failed${dominantError ? ` (dominant error: ${dominantError})` : ''}: investigate driver logs for executor instability or data-driven errors.`,
      };
    },
    estimate: noWasteModel,
  }),
  defineStageDetector({
    type: 'straggler', order: 70, fixEffort: 'code', version: 1,
    emits: ['straggler'],
    docAnchor: '#bottleneck-straggler',
    // floorPctWarn/floorPctCrit default to impact-band.ts's run-wide noise floor, so a tail this
    // gate admits at its warn floor grades at least warning there too.
    // shareWarnAtFloor: in a large stage, the few stragglers that gate it for tens of seconds can be
    // only 2.5-5% of its tasks. Scored against a task-level replay of every stage on 14 real logs
    // (recoverable = replay with each task over 4x P50 capped at P50), admitting 2.5-5% shares
    // whose clipped tail already clears floorPctWarn found 3 such stages (10-48s) for 1 borderline
    // miss; admitting every 2.5% share instead added 86 findings below the floor.
    // A stage shorter than floorPctWarn of the run is skipped outright: its tail can't cost more
    // than the stage's own duration, so every finding there graded info. On the 14 real logs that
    // was 671 of 753 straggler findings, none above info; the slow tail is still real on those
    // stages, the floor is why they're dropped.
    thresholds: { minTasks: 10, shareWarn: 0.05, shareWarnAtFloor: 0.025, warnPct: 0.10, critPct: 0.20, floorPctWarn: IMPACT_FLOOR_PCT_WARN, floorPctCrit: IMPACT_FLOOR_PCT_CRIT },
    detect(stage, ctx, thresholds): Finding | null {
      if (stage.taskCount < thresholds.minTasks) return null;
      const runMs = appDurationMs(ctx.app);
      if (stageBelowRuntimeFloor(stage, ctx, thresholds.floorPctWarn)) return null;
      const stragglerShare = (stage.stragglerCount ?? 0) / stage.taskCount;
      const useSpeculative = (stage.speculativeTasks ?? 0) > 0;
      if (!useSpeculative && stragglerShare <= thresholds.shareWarnAtFloor) return null;
      const speculativeShare = useSpeculative ? stage.speculativeTasks / stage.taskCount : 0;
      // The claim estimate() reports as savings: a high straggler/speculative share on a stage
      // whose tasks barely vary models near-zero savings, so it must not outrank 'info'.
      const floorWasteMs = tailClaimFloorMs(stragglerTailClaim(stage), stage.id, ctx);
      const meetsWarnFloor = meetsRuntimeFloor(floorWasteMs, runMs, thresholds.floorPctWarn);
      const meetsCritFloor = meetsRuntimeFloor(floorWasteMs, runMs, thresholds.floorPctCrit);
      // The lower gate needs positive evidence the tail matters: meetsRuntimeFloor passes by
      // default when the app's duration is unknown (an incomplete run), which isn't that.
      const stragglerShareFires = stragglerShare > thresholds.shareWarn
        || (stragglerShare > thresholds.shareWarnAtFloor && runMs != null && meetsWarnFloor);
      if (!useSpeculative && !stragglerShareFires) return null;
      const speculativeTier = speculativeShare >= thresholds.critPct && meetsCritFloor ? 'critical'
                             : speculativeShare >= thresholds.warnPct && meetsWarnFloor ? 'warning' : 'info';
      // Straggler share has no dedicated critical tier per detector-contract.md; only warning.
      const stragglerTier = stragglerShareFires && meetsWarnFloor ? 'warning' : 'info';
      // Fixed fallback: overwritten by deriveImpactBand when this finding gets a real wallClock
      // estimate (the common case). Only surfaces on the rare occupancy-sweep miss.
      const impactBand = 'info';
      // Report whichever signal actually drove the finding, not just whether speculation was on:
      // a high stragglerShare with few speculative retries must not be reported as a low-value
      // speculativeTasks count. Ties keep the speculative-driven default.
      const useSpeculativeMetric = useSpeculative && !(IMPACT_BAND_ORDER[stragglerTier] < IMPACT_BAND_ORDER[speculativeTier]);
      const value = useSpeculativeMetric ? stage.speculativeTasks : Math.round(stragglerShare * 100);
      const detail = useSpeculativeMetric
        ? `${value} speculative attempt${value === 1 ? '' : 's'} discarded`
        : `${value}% of tasks straggled`;
      // The skew advice fits only a stage that reads a shuffle feeding a join (skewFix).
      const fix = skewFix(stage, ctx);
      return {
        type: 'straggler', stageId: stage.id, impactBand, origin: fix.origin,
        metric: useSpeculativeMetric ? 'speculativeTasks' : 'stragglerShare',
        value,
        unit: useSpeculativeMetric ? 'count' : 'pct',
        speculativeTasks: stage.speculativeTasks ?? 0,
        stragglerCount: stage.stragglerCount ?? 0,
        confidence: useSpeculativeMetric
          ? stragglerConfidence(speculativeShare, thresholds.warnPct, thresholds.critPct)
          : stragglerConfidence(stragglerShare, thresholds.shareWarn, thresholds.critPct),
        validationRequired: `Warning needs at least ${shareLabel(thresholds.floorPctWarn)} of run time at stake, critical ${shareLabel(thresholds.floorPctCrit)}.`,
        recommendation: `${detail}: rule out a GC pause or a slow shuffle fetch before assuming a hardware issue; if uneven data is the cause, ${fix.text}.`,
        remediation: fix.remediation,
      };
    },
    estimate(finding, ctx): ImpactEstimate | null {
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      return tailClaimImpact(stragglerTailClaim(stage), finding.stageId, ctx);
    },
  }),
  defineStageDetector({
    type: 'speculationWaste', order: 71, fixEffort: 'config', version: 1,
    emits: ['speculationWaste'],
    docAnchor: '#bottleneck-speculation-waste',
    thresholds: { minWasted: 5, minWasteMs: 60000 },
    detect(stage, _ctx, thresholds): Finding | null {
      const wasted = stage.speculationWastedAttempts ?? 0;
      const wastedMs = stage.speculationWasteMs ?? 0;
      if (wasted < thresholds.minWasted || wastedMs < thresholds.minWasteMs) return null;
      return {
        type: 'speculationWaste', stageId: stage.id,
        impactBand: 'warning',
        metric: 'speculationWasteMs', value: wastedMs,
        confidence: speculationWasteConfidence(wastedMs, thresholds.minWasteMs),
        recommendation: `Speculative execution discarded ${Math.round(wastedMs / 1000)}s of executor time in this stage: if task durations are naturally variable rather than genuine stragglers, consider tuning spark.speculation.multiplier/quantile.`,
        remediation: [increaseConf('spark.speculation.multiplier'), increaseConf('spark.speculation.quantile')],
      };
    },
    estimate(finding, ctx): ImpactEstimate | null {
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      const wasteMs = (stage.speculationWasteMs as number | undefined) ?? 0;
      return singleStageImpact(wasteMs, finding.stageId, ctx, 'measured', { value: wasteMs, unit: 'ms' });
    },
  }),
  defineStageDetector({
    type: 'retryWaste', order: 45, fixEffort: 'code', version: 1,
    emits: ['retryWaste'],
    docAnchor: '#bottleneck-retry-waste',
    thresholds: { minWasted: 3, minWasteMs: 30000 },
    detect(stage, _ctx, thresholds): Finding | null {
      const wasted = stage.wastedAttempts ?? 0;
      const wastedMs = stage.retryWasteMs ?? 0;
      if (wasted < thresholds.minWasted || wastedMs < thresholds.minWasteMs) return null;
      return {
        type: 'retryWaste', stageId: stage.id,
        impactBand: 'warning',
        metric: 'retryWasteMs', value: wastedMs,
        numTasks: stage.taskCount,
        memoryBytesSpilled: stage.memoryBytesSpilled,
        retriedTaskDetails: stage.retryTaskSamples ?? [],
        recommendation: `Retried task attempts wasted ${Math.round(wastedMs / 1000)}s of executor time (${wasted} attempt${wasted === 1 ? '' : 's'}) even though the stage completed: investigate executor loss or fetch failures.`,
        extended: `${wasted} task attempts were superseded by a later retry, wasting ${Math.round(wastedMs / 1000)}s of executor time. Common causes: executor loss (OOM-kill, node death) or shuffle FetchFailed forcing a stage-map recompute. Check driver logs for the dominant reason (see the Failures widget) even if the final failure rate looks low; retries hide the true cost.`,
      };
    },
    estimate(finding, ctx): ImpactEstimate | null {
      // The waste figure lives on the Stage, not the Finding: detect() only re-publishes it as metric/value.
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      const wasteMs = (stage.retryWasteMs as number | undefined) ?? 0;
      const wallClockMs = retryWallClockMs(stage);
      return singleStageImpact(wallClockMs, finding.stageId, ctx,
        wallClockMs === wasteMs ? 'measured' : 'modeled', { value: wasteMs, unit: 'ms' });
    },
  }),
  defineStageDetector({
    type: 'tinyTask', order: 80, fixEffort: 'code', version: 1,
    emits: ['tinyTask'],
    docAnchor: '#bottleneck-tiny-tasks',
    // stageFloorPct: the tiered detectors' 0.5% runtime floor. Coalescing can't save more than the
    // stage's own duration, so on a shorter stage every finding graded info: on the 14 real logs
    // 132 of 151 tinyTask findings. The tasks are still tiny there; the floor is why they're dropped.
    thresholds: { minTasks: 100, maxP50: 500, maxP95: 1000, stageFloorPct: 0.005 },
    detect(stage, ctx, thresholds): Finding | null {
      if (stage.taskCount < thresholds.minTasks) return null;
      if (stageBelowRuntimeFloor(stage, ctx, thresholds.stageFloorPct)) return null;
      if (stage.taskDurationP50 > thresholds.maxP50 || stage.taskDurationP95 > thresholds.maxP95) return null;
      const coalesceTo = Math.max(1, Math.round(stage.taskCount / 10));
      const reads = stageReads(stage);
      const fix = reads === 'shuffle'
        ? `lower spark.sql.shuffle.partitions or .coalesce(${coalesceTo})`
        : `.coalesce(${coalesceTo})`;
      return {
        type: 'tinyTask', stageId: stage.id, impactBand: 'info', reads,
        metric: 'taskDurationP50', value: Math.round(stage.taskDurationP50),
        recommendation: `Many small tasks (${stage.taskCount}, P50 ${Math.round(stage.taskDurationP50)}ms): scheduler overhead may dominate. Try ${fix}.`,
        remediation: reads === 'shuffle' ? [decreaseConf('spark.sql.shuffle.partitions')] : [],
      };
    },
    estimate(finding, ctx): ImpactEstimate | null {
      if (finding.stageId == null) return null;
      const stage = ctx.stages.get(finding.stageId);
      if (!stage) return null;
      const taskCount = stage.taskCount ?? 0;
      const excessTaskCount = Math.max(0, taskCount - Math.round(taskCount / 10));
      const measured = measuredTaskOverhead(stage);
      if (measured) {
        // Coalescing to a tenth of the tasks removes the excess tasks' per-task overhead: core
        // time spent in parallel, so wall-clock at the stage's achieved concurrency (floored at
        // 1: a mostly-idle stage can't save more wall-clock than the task time it removes).
        const wasteMs = (excessTaskCount * measured.perTaskMs) / Math.max(1, measured.concurrency);
        return singleStageImpact(wasteMs, finding.stageId, ctx, 'measured', { value: wasteMs, unit: 'ms' });
      }
      const wasteMs = excessTaskCount * TASK_SCHEDULING_OVERHEAD_MS;
      return singleStageImpact(wasteMs, finding.stageId, ctx, 'modeled', { value: wasteMs, unit: 'ms' });
    },
  }),
  defineAppDetector({
    // No docAnchor: the upstream spark-tuning-reference docs have no section for this
    // tool-specific "capture stopped early" signal.
    type: 'incompleteRun', order: 5, fixEffort: 'code', version: 1,
    emits: ['incompleteRun'],
    thresholds: {},
    detect(ctx): Finding | null {
      if (!ctx.app || ctx.app.startTime == null || ctx.app.endTime != null) return null;
      return {
        type: 'incompleteRun', stageId: null, impactBand: 'warning',
        metric: 'applicationEnd', valueText: 'missing',
        recommendation: INCOMPLETE_RUN_RECOMMENDATION,
      };
    },
    estimate: noWasteModel,
  }),
  defineAppDetector({
    type: 'coldStart', order: 90, fixEffort: 'code', version: 1,
    emits: ['coldStart'],
    docAnchor: '#bottleneck-cold-start',
    thresholds: { gapSeconds: 30 },
    detect(ctx, thresholds): Finding | null {
      const { app, stages, executorsAdded, executorsRemoved } = ctx;
      // Nullish (not falsy) check: a literal startTime:0 must not be treated as "missing".
      if (!app || app.startTime == null || stages.size === 0) return null;
      let firstStageSubmitted = Infinity;
      for (const stage of stages.values()) {
        if (stage.submittedAt > 0 && stage.submittedAt < firstStageSubmitted) firstStageSubmitted = stage.submittedAt;
      }
      // No stage ever recorded a submission timestamp: no basis to measure a startup gap against.
      if (!Number.isFinite(firstStageSubmitted)) return null;
      // The wait is from the first runnable stage to the first executor, not from app start: the
      // driver's own startup before its first job (36-47s on every real log, whatever the
      // executors did) isn't something executors could shorten. On the 9 real logs that fired,
      // the first executor arrived 146-192s after the first stage on two whose old gap read ~40s,
      // and 2s after it on one the old gap flagged critical at 42s.
      // An executor added before the first stage only counts if it was still alive at submission:
      // with dynamic allocation scaling to zero, early executors can idle out before any job runs.
      const removedAt = new Map<string, number>();
      for (const ev of executorsRemoved) removedAt.set(ev.executorId, ev.timestamp);
      let firstExecutorAdded = Infinity;
      for (const e of executorsAdded) {
        if (!(e.timestamp > 0)) continue;
        if (e.timestamp <= firstStageSubmitted) {
          const removed = removedAt.get(e.executorId);
          if (removed == null || removed > firstStageSubmitted) return null;
        } else if (e.timestamp < firstExecutorAdded) {
          firstExecutorAdded = e.timestamp;
        }
      }
      if (!Number.isFinite(firstExecutorAdded)) return null;
      const gapSeconds = (firstExecutorAdded - firstStageSubmitted) / 1000;
      if (gapSeconds <= thresholds.gapSeconds) return null;
      const value = Math.round(gapSeconds);
      return {
        type: 'coldStart', stageId: null, impactBand: 'warning',
        dynamicAllocation: dynamicAllocationOff(ctx.app) ? 'off' : 'on',
        metric: 'startupGapSeconds', value,
        recommendation: `The first stage waited ${value}s for an executor to become available: keep a warm pool of idle executors, or if using dynamic allocation, raise the minimum/initial executor count so it doesn't scale up from zero.`,
        remediation: dynamicAllocationOff(ctx.app) ? [] : [increaseConf('spark.dynamicAllocation.minExecutors'), increaseConf('spark.dynamicAllocation.initialExecutors')],
      };
    },
    estimate(finding): ImpactEstimate | null {
      // detect() reports the gap as `metric: 'startupGapSeconds', value: <seconds>`.
      if (typeof finding.value !== 'number') return null;
      const wasteMs = finding.value * 1000;
      // Time before any task starts can never overlap any stage; a genuine unclipped point estimate,
      // not tied to any stage's gate (coldStart is app-scoped, stageId: null).
      return { basis: 'serial', wallClock: { low: wasteMs, high: wasteMs }, estimateMethod: 'measured' };
    },
  }),
  defineAppDetector({
    type: 'utilization', order: 100, fixEffort: 'config', version: 1,
    emits: ['utilization'],
    docAnchor: '#bottleneck-utilization',
    thresholds: { minUtil: 0.60 },
    detect(ctx, thresholds): Finding | null {
      const { app, executorsAdded, executorsRemoved, runAggregates } = ctx;
      // Nullish (not falsy) check: a literal startTime:0 must not be treated as "missing".
      if (!app || executorsAdded.length === 0 || app.startTime == null || app.endTime == null) return null;
      const appDuration = app.endTime - app.startTime;
      if (appDuration <= 0) return null;
      // Capacity is what the run was allocated (cores x time alive, the figure behind
      // metrics.allocation.coreHours), not peak concurrent cores x the whole run: under dynamic
      // allocation or late-joining executors that is more than was ever held, and the idle figure
      // would exceed the allocation. Null without executor cores.
      const capacityCoreMs = allocatedCoreMs({ app, stages: ctx.stages, executors: { added: executorsAdded, removed: executorsRemoved } });
      if (capacityCoreMs == null) return null;
      // Peak concurrent cores (not computeTotalCores, a cumulative sum that double-counts a
      // churned-through executor against its replacement): the cluster size the finding reports.
      const totalCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);
      // Busy core-time (from the whole-run core-time-series, same signal memoryUtilization's
      // idleCores variant already uses), not executor lifetime: an executor that exists for the
      // whole run but sits fully idle must not score as 100% used. Missing runAggregates (older
      // callers, synthetic fixtures) reads as 0 busy time rather than falling back to the
      // lifetime-based measure this replaces.
      const busyCoreMs = runAggregates?.busyCoreMs ?? 0;
      const utilization = busyCoreMs / capacityCoreMs;
      if (utilization >= thresholds.minUtil) return null;

      // CPU-time-based utilization (sparkMeasure): metric only, no threshold.
      // Null when no stage recorded CPU time (older Spark), the same rule as the CLI metrics block.
      const cpuMs = totalExecutorCpuMs(ctx.stages.values());
      const cpuUtilizationPct = cpuMs == null ? null : Math.round((cpuMs / capacityCoreMs) * 100);

      const value = Math.round(utilization * 100);
      const fix = idleCapacityFix(app, 'consider either reducing cluster size (spark.executor.instances) or enabling dynamic allocation',
        'dynamic allocation is already on, so consider reducing cluster size');
      return {
        type: 'utilization', stageId: null, impactBand: 'info',
        metric: 'avgUtilization', value,
        utilizationFraction: utilization,
        appDurationMs: appDuration,
        totalCores,
        allocatedCoreMs: capacityCoreMs,
        cpuUtilizationPct,
        recommendation: `Average executor utilization was only ${value}%: ${fix.text}.`,
        remediation: fix.remediation,
      };
    },
    estimate(finding): ImpactEstimate | null {
      const fraction = finding.utilizationFraction as number | undefined;
      const allocatedMs = finding.allocatedCoreMs as number | undefined;
      if (fraction == null || allocatedMs == null) {
        return costOnly('measured');
      }
      // The same allocated-minus-busy figure as `rawWaste`, in core-milliseconds, next to (never in)
      // coreTimeMs: that field is busy task time a fix removes, this is capacity no task used.
      const idleMs = (1 - fraction) * allocatedMs;
      return {
        ...costOnly('measured', { value: idleMs / MS_PER_CORE_HOUR, unit: 'coreHours', idle: true }),
        idleCoreTimeMs: { low: idleMs, high: idleMs },
      };
    },
  }),
  defineAppDetector({
    type: 'memoryUtilization', order: 102, fixEffort: 'config', version: 1,
    emits: ['memoryUtilization'],
    docAnchor: '#bottleneck-memory-utilization',
    thresholds: {
      idleCoreWarn: 0.50,          // WastedCoresAlertsReducer
      bandTooSmall: 0.95,          // MemoryAlertsReducer: used/allocated
      bandTooHigh: 0.70,           // below this => over-provisioned (cost signal)
      wasteBufferMultiplier: 1.5,  // UNVERIFIED
    },
    detect(ctx, thresholds): Finding[] {
      const { app, executorsAdded, executorsRemoved, runAggregates, stages } = ctx;
      const out: Finding[] = [];
      // Nullish (not falsy) check: a literal startTime:0 must not be treated as "missing".
      if (app?.startTime == null || app?.endTime == null) return out;
      const appDurationMs = app.endTime - app.startTime;
      if (appDurationMs <= 0) return out;

      // Peak concurrent executors/cores (not executorsAdded.length/computeTotalCores): a
      // cumulative sum or count double-counts a churned-through executor against its replacement's
      // (spot preemption, dynamicAllocation replacement), inflating idle-rate and waste-model figures.
      const peakExecutors = computePeakConcurrentExecutorCount(executorsAdded, executorsRemoved);
      const allocatedMB = app.resources?.executor?.memoryMB ?? null;

      // ── 1a idle-cores rate ────────────────────────────────────────────────
      const busyCoreMs = runAggregates?.busyCoreMs;
      // Allocated core-time, as for `utilization`, so the two findings of one idle condition agree.
      const allocationInput = { app, stages, executors: { added: executorsAdded, removed: executorsRemoved } };
      const capacityCoreMs = allocatedCoreMs(allocationInput);
      if (busyCoreMs != null && capacityCoreMs != null) {
        const idleRate = 1 - (busyCoreMs / capacityCoreMs);
        if (idleRate > thresholds.idleCoreWarn) {
          const value = Math.round(idleRate * 100);
          const { memoryGbHours } = computeAllocation(allocationInput);
          const fix = idleCapacityFix(app, 'either reduce cluster size (spark.executor.instances) or enable dynamic allocation',
            'dynamic allocation is already on, so reduce cluster size');
          out.push({
            type: 'memoryUtilization', variant: 'idleCores', stageId: null,
            impactBand: 'warning', metric: 'idleCoreRate', value,
            // Raw (unrounded) rate plus the allocated memory-time for the impact estimator: `value` is rounded pct.
            idleRateFraction: idleRate,
            allocatedMBSeconds: memoryGbHours != null ? memoryGbHours * 1024 * 3600 : null,
            recommendation: `${value}% of available core-time ran no task: ${fix.text}.`,
            remediation: fix.remediation,
          });
        }
      }

      // ── 1b memory bands (executor only; driver half dropped since there is no driver metric) ─
      // Peak heap per executor = max jvmHeapMemory across all stages' executorMetrics.
      const peakHeapByExec = new Map<string, number>();
      for (const s of stages.values()) {
        const em = s.executorMetrics;
        if (!(em instanceof Map)) continue;
        for (const [execId, m] of em) {
          const heap = m?.jvmHeapMemory ?? 0;
          if (heap > (peakHeapByExec.get(execId) ?? 0)) peakHeapByExec.set(execId, heap);
        }
      }
      if (peakHeapByExec.size === 0) {
        const key = 'spark.eventLog.logStageExecutorMetrics';
        const fix = switchFix(loggedAs(app, key, true), key, true,
          `Per-executor memory usage requires ${key}=true: not enabled for this run.`,
          'Per-executor memory usage is missing from this log even though executor metrics logging is on for this run.');
        out.push({
          type: 'memoryUtilization', variant: 'memoryBand', stageId: null,
          impactBand: 'info', metric: 'memoryBand', dataUnavailable: true,
          recommendation: fix.text,
          remediation: fix.remediation,
        });
      } else if (allocatedMB != null && allocatedMB > 0) {
        const allocatedBytes = allocatedMB * 1024 * 1024;
        for (const [execId, heap] of peakHeapByExec) {
          const ratio = heap / allocatedBytes;
          // The two bands are opposite signals: an explicit `rule` discriminator lets consumers
          // tell OOM-risk from over-provisioning without re-deriving the ratio.
          if (ratio > thresholds.bandTooSmall) {
            out.push({
              type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity',
              stageId: null, executorId: execId,
              impactBand: 'warning', metric: 'heapUsedRatio', value: Math.round(ratio * 100),
              recommendation: `Executor ${execId} peaked at ${Math.round(ratio * 100)}% of allocated heap: memory may be too small; raise spark.executor.memory to avoid OOM/spill.`,
              remediation: [increaseConf('spark.executor.memory')],
            });
          } else if (ratio < thresholds.bandTooHigh) {
            out.push({
              type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned',
              stageId: null, executorId: execId,
              impactBand: 'info', metric: 'heapUsedRatio', value: Math.round(ratio * 100),
              // Absolute figures behind the rounded ratio, for the estimator's
              // unused-memory-over-time model.
              allocatedBytes, heap, appDurationMs,
              recommendation: `Executor ${execId} used only ${Math.round(ratio * 100)}% of allocated heap: memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.`,
              remediation: [decreaseConf('spark.executor.memory')],
            });
          }
        }
      }

      // ── 1c Spark Memory Limit waste model (UNVERIFIED buffer) ─
      if (allocatedMB != null && peakExecutors > 0) {
        const allocatedMBSeconds = peakExecutors * allocatedMB * (appDurationMs / 1000);
        let usedRunTimeMs = 0;
        for (const s of stages.values()) usedRunTimeMs += s.executorRunTime ?? 0;
        const usedMBSeconds = allocatedMB * (usedRunTimeMs / 1000);
        const wastedMBSeconds = allocatedMBSeconds - usedMBSeconds;
        if (wastedMBSeconds > thresholds.wasteBufferMultiplier * usedMBSeconds) {
          const value = Math.round(wastedMBSeconds);
          out.push({
            type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
            impactBand: 'info', metric: 'wastedMBSeconds', value,
            confidence: memoryWasteConfidence(wastedMBSeconds, usedMBSeconds, thresholds.wasteBufferMultiplier),
            validationRequired: `Memory-waste estimate uses allocated-vs-used memory-time and a ${thresholds.wasteBufferMultiplier}x buffer: confirm against the Spark UI before acting.`,
            recommendation: `Allocated executor memory sat largely idle over the run (~${value.toLocaleString('en-US')} MB-seconds wasted): review spark.executor.memory and executor count.`,
            remediation: [decreaseConf('spark.executor.memory')],
          });
        }
      }

      return out;
    },
    estimate(finding): ImpactEstimate | null {
      // The wasteModel variant reports metric: 'wastedMBSeconds', value: <MB-seconds>.
      if (finding.variant === 'wasteModel' && typeof finding.value === 'number') {
        return costOnly('measured', { value: finding.value, unit: 'mbSeconds' });
      }
      if (finding.variant === 'idleCores') {
        // Idle core-time priced as memory held but unused: the allocated memory-seconds times the idle rate.
        const idleRateFraction = finding.idleRateFraction as number | undefined;
        const allocatedMBSeconds = finding.allocatedMBSeconds as number | null | undefined;
        if (idleRateFraction != null && allocatedMBSeconds != null) {
          const wastedMBSeconds = idleRateFraction * allocatedMBSeconds;
          return costOnly('modeled', { value: wastedMBSeconds, unit: 'mbSeconds' });
        }
        return costOnly('modeled');
      }
      // Only the over-provisioned band is a waste; the near-capacity band is an OOM-risk signal with
      // no magnitude, and the dataUnavailable shape has no inputs: both stay informational.
      if (finding.variant === 'memoryBand' && finding.rule === 'heapOverProvisioned') {
        const allocatedBytes = finding.allocatedBytes as number | undefined;
        const heap = finding.heap as number | undefined;
        const appDurationMs = finding.appDurationMs as number | undefined;
        if (allocatedBytes != null && heap != null && appDurationMs != null) {
          const unusedMB = (allocatedBytes - heap) / (1024 * 1024);
          const wastedMBSeconds = unusedMB * (appDurationMs / 1000);
          return costOnly('modeled', { value: wastedMBSeconds, unit: 'mbSeconds' });
        }
      }
      return costOnly('modeled');
    },
  }),
  defineAppDetector({
    // Per-RDD cache-utilization proxies (this repo's own design: Spark event logs carry no
    // block-access events, so a literal cache hit rate isn't derivable). Two per-RDD tiered
    // checks over rddInfo: partial caching and disk spillover. An RDD can produce both. rddInfo's
    // sizes come from SparkListenerBlockUpdated when the log has it, else from StageSubmitted's
    // RDD Info (0 since Spark 2.3; Spark 1.x fills it only on StageCompleted); with neither, on
    // Spark 2.3+ with logBlockUpdates off, a storageUnobserved caveat replaces them.
    type: 'cacheUtilization', order: 103, fixEffort: 'code', version: 2,
    emits: ['cacheUtilization'],
    docAnchor: '#bottleneck-cache-utilization',
    thresholds: {
      cachedRatioWarn: 0.50, cachedRatioInfo: 0.90,
      diskRatioWarn: 0.40, diskRatioInfo: 0.15,
    },
    detect(ctx, thresholds): Finding[] | null {
      const rddInfo = ctx.app?.rddInfo;
      if (!(rddInfo instanceof Map)) return null;
      const out: Finding[] = [];
      let persistedRddCount = 0;
      // With block-update logging on, zero rdd_* updates means nothing was ever cached, not a gap.
      const blockUpdatesLogged = String(ctx.app?.config?.['spark.eventLog.logBlockUpdates.enabled']).toLowerCase() === 'true';
      // Spark before 2.3 has no block-update logging and writes RDD Info's cache figures only on
      // StageCompleted, which isn't read: the caveat's advice doesn't apply there. A log with no
      // version is pre-1.3 (no SparkListenerLogStart); every 2.3+ log records one.
      const version = /^(\d+)\.(\d+)/.exec(ctx.app?.sparkVersion ?? '');
      const preBlockUpdates = version == null || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 3);
      let anyStorageEvidence = blockUpdatesLogged || preBlockUpdates || (ctx.app?.rddBlockUpdates ?? 0) > 0;
      for (const rdd of rddInfo.values()) {
        const sl = rdd.storageLevel ?? {};
        if (!(sl.useMemory || sl.useDisk)) continue;
        persistedRddCount++;
        if (!((rdd.numCachedPartitions ?? 0) > 0)) continue;
        anyStorageEvidence = true;

        if ((rdd.numPartitions ?? 0) > 0) {
          const cachedRatio = rdd.numCachedPartitions / rdd.numPartitions;
          if (cachedRatio < thresholds.cachedRatioWarn) out.push(partialCacheFinding(rdd, cachedRatio, 'warning'));
          else if (cachedRatio < thresholds.cachedRatioInfo) out.push(partialCacheFinding(rdd, cachedRatio, 'info'));
        }

        if (sl.useMemory && sl.useDisk) {
          const total = (rdd.memorySize ?? 0) + (rdd.diskSize ?? 0);
          if (total > 0) {
            const diskRatio = (rdd.diskSize ?? 0) / total;
            if (diskRatio > thresholds.diskRatioWarn) out.push(diskSpilloverFinding(rdd, diskRatio, 'warning'));
            else if (diskRatio > thresholds.diskRatioInfo) out.push(diskSpilloverFinding(rdd, diskRatio, 'info'));
          }
        }
      }
      if (persistedRddCount > 0 && !anyStorageEvidence) out.push(storageUnobservedFinding(persistedRddCount, ctx.app));
      return out;
    },
    estimate(finding): ImpactEstimate | null {
      // storageUnobserved reports missing evidence: no sizes, so nothing to model.
      if (finding.dataUnavailable) return costOnly('none');
      const memorySize = (finding.memorySize as number | undefined) ?? 0;
      const diskSize = (finding.diskSize as number | undefined) ?? 0;
      const numCachedPartitions = (finding.numCachedPartitions as number | undefined) ?? 0;
      const numPartitions = (finding.numPartitions as number | undefined) ?? 0;
      const numUncachedPartitions = Math.max(0, numPartitions - numCachedPartitions);
      const cachedBytes = memorySize + diskSize;
      // Extrapolate never-cached partitions' size from the CACHED partitions' average (uncached/
      // cached, not uncached/total: numCachedPartitions produced cachedBytes). diskSize is added
      // once more: those bytes are cached but on disk, so re-reading them still costs I/O like an uncached partition.
      const uncachedBytes = numCachedPartitions > 0 ? (cachedBytes / numCachedPartitions) * numUncachedPartitions : 0;
      const uncachedOrSpilledBytes = uncachedBytes + diskSize;
      const wasteMs = (uncachedOrSpilledBytes / RE_READ_THROUGHPUT_BPS) * 1000;
      return costOnly('modeled', { value: wasteMs, unit: 'ms' });
    },
  }),
  defineAppDetector({
    // Non-local task ratio across stage.localityStats (RACK_LOCAL + ANY vs all tasks), the other
    // half of the "Wasted Cores Ratio" (idle-core half is memoryUtilization's idleCores).
    // NO_PREF stays in the denominator only: shuffle-read stages legitimately report it.
    type: 'coreLocality', order: 103, fixEffort: 'config', version: 1,
    emits: ['coreLocality'],
    docAnchor: '#bottleneck-core-locality',
    thresholds: { minTasks: 50, warnRatio: 0.15, critRatio: 0.35 },
    detect(ctx, thresholds): Finding | null {
      const { totalTasks, nonLocalTasks, ratio } = computeCoreLocalityRatio([...ctx.stages.values()]);
      if (totalTasks == null || totalTasks < thresholds.minTasks) return null;
      // computeCoreLocalityRatio only returns ratio:null together with totalTasks:null (shared
      // EMPTY sentinel); the totalTasks guard above rules that out, so ratio is non-null here.
      if (ratio! < thresholds.warnRatio) return null;

      const value = Math.round(ratio! * 100);
      return {
        type: 'coreLocality', stageId: null,
        impactBand: ratio! >= thresholds.critRatio ? 'critical' : 'warning',
        metric: 'nonLocalRatio', value,
        // Raw count behind the ratio, for the impact estimator. Non-null whenever totalTasks is.
        nonLocalTaskCount: nonLocalTasks!,
        confidence: coreLocalityConfidence(ratio!, totalTasks, thresholds),
        validationRequired: `Flagged when at least ${shareLabel(thresholds.warnRatio)} of tasks run non-local (critical at ${shareLabel(thresholds.critRatio)}), on runs of ${thresholds.minTasks}+ tasks.`,
        recommendation: `${value}% of tasks (${nonLocalTasks!}) ran without process- or node-local data placement: check executor/data colocation.`,
      };
    },
    estimate(finding): ImpactEstimate | null {
      const nonLocal = (finding.nonLocalTaskCount as number | undefined) ?? 0;
      const coreMs = nonLocal * NETWORK_FETCH_PENALTY_MS;
      return costOnly('modeled', { value: coreMs, unit: 'coreMs' });
    },
  }),
  defineAppDetector({
    // Short-lived executors: stood up and torn down before doing useful work (wasteful
    // re-provisioning, not normal scale-down). Reuses utilization's add/remove matching, but
    // measures lifetime against a threshold instead of aggregate active-time.
    type: 'autoscalingChurn', order: 103, fixEffort: 'config', version: 1,
    emits: ['autoscalingChurn'],
    docAnchor: '#bottleneck-autoscaling-churn',
    thresholds: { shortLivedMs: 120_000, warningPct: 0.30, criticalPct: 0.60, minExecutors: 5 },
    detect(ctx, thresholds): Finding | null {
      const { app, executorsAdded, executorsRemoved } = ctx;
      if (!app || executorsAdded.length === 0 || app.endTime == null) return null;
      if (executorsAdded.length < thresholds.minExecutors) return null;

      const removedAt = new Map<string, number>();
      for (const ev of executorsRemoved) removedAt.set(ev.executorId, ev.timestamp);

      let shortLivedCount = 0;
      for (const ev of executorsAdded) {
        const endedAt = removedAt.has(ev.executorId) ? removedAt.get(ev.executorId)! : app.endTime;
        const lifetime = endedAt - ev.timestamp;
        if (lifetime < thresholds.shortLivedMs) shortLivedCount++;
      }

      const shortLivedPct = shortLivedCount / executorsAdded.length;
      const impactBand = shortLivedPct > thresholds.criticalPct ? 'critical'
                        : shortLivedPct > thresholds.warningPct ? 'warning' : null;
      if (!impactBand) return null;

      const pct = Math.round(shortLivedPct * 100);
      const daOff = dynamicAllocationOff(app);
      return {
        type: 'autoscalingChurn', stageId: null, impactBand,
        metric: 'shortLivedExecutorPct', value: pct,
        // Raw count behind the percentage, for the impact estimator's startup-overhead figure.
        shortLivedExecutorCount: shortLivedCount,
        confidence: autoscalingChurnConfidence(shortLivedPct, thresholds.warningPct, thresholds.criticalPct),
        // No dynamic-allocation property has an effect when the run's conf turns it off (as for coldStart).
        dynamicAllocation: daOff ? 'off' : 'on',
        recommendation: daOff
          ? `${pct}% of executors ran for under 2 minutes before being removed: dynamic allocation is off, so the churn comes from executors lost or preempted, not from autoscaling bounds; check the cluster manager's preemption and executor-loss logs.`
          : `${pct}% of executors ran for under 2 minutes before being removed: this looks like wasteful re-provisioning rather than normal scale-down; consider raising spark.dynamicAllocation.executorIdleTimeout or widening the minExecutors/maxExecutors bounds to reduce flapping.`,
        remediation: daOff ? [] : [
          increaseConf('spark.dynamicAllocation.executorIdleTimeout'),
          decreaseConf('spark.dynamicAllocation.minExecutors'),
          increaseConf('spark.dynamicAllocation.maxExecutors'),
        ],
      };
    },
    estimate(finding): ImpactEstimate | null {
      const shortLived = (finding.shortLivedExecutorCount as number | undefined) ?? 0;
      const executorHours = (shortLived * EXECUTOR_STARTUP_OVERHEAD_MS) / 3.6e6;
      return costOnly('modeled', { value: executorHours, unit: 'coreHours' });
    },
  }),
  defineAppDetector({
    // Cross-execution relation reuse: flags an input relation scanned by two or more SQL
    // executions in one run, firing on real relation names (parquet:..., jdbc:...).
    type: 'cachingOpportunity', order: 105, fixEffort: 'code', version: 1,
    emits: ['cachingOpportunity'],
    docAnchor: '#bottleneck-caching-opportunity',
    thresholds: { minExecutions: 2 },
    detect(ctx, thresholds): Finding[] | null {
      const sql = ctx.sql;
      if (!(sql instanceof Map) || sql.size === 0) return null;

      interface RelationAgg {
        format: string; relation: string;
        executionIds: Set<number>; executionBytes: Map<number, number>;
      }
      interface PerExecCompositeAgg {
        operator: 'join' | 'union'; node: PlanNode;
        leafRelationBytes: Map<string, number>; ancestorFingerprints: Set<string>;
      }
      interface ByCompositeAgg {
        operator: 'join' | 'union'; exampleNode: PlanNode;
        executionIds: Set<number>; executionBytes: Map<number, number>;
        ancestorFingerprints: Set<string>; leafRelationRids: Set<string>;
      }
      interface CompositeResolution { finalExecutionIds: Set<number>; suppressed: boolean; }

      const byRelation = new Map<string, RelationAgg>();
      for (const exec of sql.values()) {
        if (!exec.planTree) continue;
        // Dedupe relations within one execution (self-joins count once), summing read bytes per relation.
        const perExec = new Map<string, number>();
        walkPlanTree(exec.planTree, (node) => {
          const rid = relationIdOf(node);
          if (!rid) return;
          const bytesMetric = (node.metrics ?? []).find(m => m.name === FILES_READ_BYTES);
          perExec.set(rid, (perExec.get(rid) ?? 0) + (bytesMetric ? bytesMetric.value : 0));
        });
        for (const [rid, bytes] of perExec) {
          let agg = byRelation.get(rid);
          if (!agg) {
            const colon = rid.indexOf(':');
            agg = { format: rid.slice(0, colon), relation: rid.slice(colon + 1), executionIds: new Set(), executionBytes: new Map() };
            byRelation.set(rid, agg);
          }
          agg.executionIds.add(exec.id);
          agg.executionBytes.set(exec.id, (agg.executionBytes.get(exec.id) ?? 0) + bytes);
        }
      }

      const byComposite = new Map<string, ByCompositeAgg>();
      for (const exec of sql.values()) {
        if (!exec.planTree) continue;
        const candidates = findCompositeCandidates(exec.planTree);
        const fingerprintByNode = new Map<PlanNode, string>(candidates.map((c): [PlanNode, string] => [c.node, c.fingerprint]));

        // Dedupe identical fingerprints within this execution (repeated composite counts once).
        const perExecComposite = new Map<string, PerExecCompositeAgg>();
        for (const c of candidates) {
          let agg = perExecComposite.get(c.fingerprint);
          if (!agg) {
            agg = {
              operator: c.operator, node: c.node,
              leafRelationBytes: new Map(),
              ancestorFingerprints: new Set(
                c.ancestorNodes.map(n => fingerprintByNode.get(n)).filter((fp): fp is string => Boolean(fp)),
              ),
            };
            perExecComposite.set(c.fingerprint, agg);
          }
          for (const [rid, bytes] of c.leafRelationBytes) {
            agg.leafRelationBytes.set(rid, (agg.leafRelationBytes.get(rid) ?? 0) + bytes);
          }
        }

        for (const [fingerprint, agg] of perExecComposite) {
          let cAgg = byComposite.get(fingerprint);
          if (!cAgg) {
            cAgg = {
              operator: agg.operator, exampleNode: agg.node,
              executionIds: new Set(), executionBytes: new Map(),
              ancestorFingerprints: new Set(), leafRelationRids: new Set(),
            };
            byComposite.set(fingerprint, cAgg);
          }
          cAgg.executionIds.add(exec.id);
          const execBytes = [...agg.leafRelationBytes.values()].reduce((sum, b) => sum + b, 0);
          cAgg.executionBytes.set(exec.id, (cAgg.executionBytes.get(exec.id) ?? 0) + execBytes);
          for (const af of agg.ancestorFingerprints) cAgg.ancestorFingerprints.add(af);
          for (const rid of agg.leafRelationBytes.keys()) cAgg.leafRelationRids.add(rid);
        }
      }

      // Qualifying = enough distinct executions on its own. Nested-dedupe: a qualifying composite
      // with a qualifying ANCESTOR is subsumed, fully (equal sets) or partially (residual).
      const isQualifying = (fp: string): boolean =>
        byComposite.has(fp) && byComposite.get(fp)!.executionIds.size >= thresholds.minExecutions;
      const compositeResolutions = new Map<string, CompositeResolution>();
      for (const [fingerprint, agg] of byComposite) {
        if (!isQualifying(fingerprint)) { compositeResolutions.set(fingerprint, { finalExecutionIds: agg.executionIds, suppressed: true }); continue; }
        const qualifyingAncestors = [...agg.ancestorFingerprints].filter(isQualifying).map(fp => byComposite.get(fp)!);
        if (qualifyingAncestors.length === 0) { compositeResolutions.set(fingerprint, { finalExecutionIds: agg.executionIds, suppressed: false }); continue; }
        const coveredByAncestors = new Set(qualifyingAncestors.flatMap(outer => [...outer.executionIds]));
        const residual = new Set([...agg.executionIds].filter(id => !coveredByAncestors.has(id)));
        if (residual.size === 0) compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: true });
        else if (residual.size < thresholds.minExecutions) compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: true });
        else compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: false });
      }

      const relationDisplayName = (rid: string): string => rid.slice(rid.indexOf(':') + 1);
      const compositeVerb: Record<'join' | 'union', [string, string]> = { join: ['joined', 'join'], union: ['unioned', 'union'] };

      const out: Finding[] = [];
      // rid -> Set<execId> covered by an emitted composite, for leaf suppression.
      const coveredExecutionsByRid = new Map<string, Set<number>>();
      for (const [fingerprint, agg] of byComposite) {
        const resolution = compositeResolutions.get(fingerprint)!;
        if (resolution.suppressed) continue;
        const finalExecutionIds = [...resolution.finalExecutionIds].sort((a, b) => a - b);
        const totalReadBytes = finalExecutionIds.reduce((sum, id) => sum + (agg.executionBytes.get(id) ?? 0), 0);
        const rids = [...agg.leafRelationRids].sort();
        if (rids.length === 0) continue;
        const relations = rids.map(rid => {
          const colon = rid.indexOf(':');
          return { relation: rid.slice(colon + 1), format: rid.slice(0, colon) };
        });
        const [verb, connector] = compositeVerb[agg.operator];
        const relationDisplay = rids.map(relationDisplayName).join(` ${connector} `);
        const value = finalExecutionIds.length;
        const recommendation = totalReadBytes >= 128 * MB
          ? `${verb[0].toUpperCase()}${verb.slice(1)} result read by ${value} queries (~${formatBytes(totalReadBytes)}): cache/persist the ${verb} DataFrame so it is computed once.`
          : `${verb[0].toUpperCase()}${verb.slice(1)} result read by ${value} queries: cache the ${verb} DataFrame, or reconsider whether it needs to be recomputed each time.`;

        out.push({
          type: 'cachingOpportunity', variant: 'composite', stageId: null, impactBand: 'info',
          metric: 'executionReuse', value,
          format: 'derived', relations, operator: agg.operator, relation: relationDisplay,
          executionIds: finalExecutionIds, totalReadBytes,
          confidence: cachingReuseConfidence(value, thresholds.minExecutions),
          validationRequired:
            'Composite reuse is inferred from a structural plan-shape match (operator + normalized ' +
            'join/filter condition + child shapes) across SQL executions; confirm these executions ' +
            'truly compute the same join/union before caching.',
          recommendation,
        });

        for (const rid of rids) {
          if (!coveredExecutionsByRid.has(rid)) coveredExecutionsByRid.set(rid, new Set());
          for (const id of finalExecutionIds) coveredExecutionsByRid.get(rid)!.add(id);
        }
      }

      for (const [rid, agg] of byRelation) {
        const covered = coveredExecutionsByRid.get(rid);
        const residualExecutionIds = covered
          ? [...agg.executionIds].filter(id => !covered.has(id))
          : [...agg.executionIds];
        if (residualExecutionIds.length < thresholds.minExecutions) continue;
        const value = residualExecutionIds.length;
        const totalReadBytes = residualExecutionIds.reduce((sum, id) => sum + (agg.executionBytes.get(id) ?? 0), 0);
        const recommendation = totalReadBytes >= 128 * MB
          ? `Read by ${value} queries (~${formatBytes(totalReadBytes)}): cache/persist the shared DataFrame so it is scanned once.`
          : `Read by ${value} queries: cache the shared DataFrame, or broadcast it if it is a small join lookup.`;
        out.push({
          type: 'cachingOpportunity', stageId: null, impactBand: 'info',
          metric: 'executionReuse', value,
          relation: agg.relation, format: agg.format,
          executionIds: residualExecutionIds.sort((a, b) => a - b),
          totalReadBytes,
          confidence: cachingReuseConfidence(value, thresholds.minExecutions),
          validationRequired:
            'Relation-reuse is inferred from the pre-AQE plan scan identity across SQL ' +
            'executions; confirm the reads are the same data and cacheable within one ' +
            'session before acting.',
          recommendation,
        });
      }
      return out;
    },
    estimate(finding): ImpactEstimate | null {
      const totalReadBytes = (finding.totalReadBytes as number | undefined) ?? 0;
      const wasteMs = (totalReadBytes / RE_READ_THROUGHPUT_BPS) * 1000;
      return costOnly('modeled', { value: wasteMs, unit: 'ms' });
    },
  }),
  defineAppDetector({
    type: 'jobFailureRate', order: 110, fixEffort: 'code', version: 1,
    emits: ['jobFailureRate'],
    docAnchor: '#bottleneck-job-failure-rate',
    thresholds: { infoRate: 0.10, warnRate: 0.30, critRate: 0.50 },
    detect(ctx, thresholds): Finding | null {
      const { jobs, stages } = ctx;
      const all = jobs ? [...jobs.values()] : [];
      const completed = all.filter(j => j.result != null);
      if (completed.length === 0) return null;
      const failedJobList = completed.filter(j => j.succeeded === false);
      const failedJobs = failedJobList.length;
      const rate = failedJobs / completed.length;
      if (rate < thresholds.infoRate) return null;
      let totalTasks = 0, failedTasks = 0;
      for (const s of stages.values()) { totalTasks += s.taskCount ?? 0; failedTasks += s.failedTasks ?? 0; }
      const taskFailureRate = totalTasks > 0 ? failedTasks / totalTasks : 0;
      // Average wall-clock of failed jobs, for the impact estimator's cost-only figure. Jobs
      // missing either timestamp are excluded (not counted as zero); with none timed the average is 0.
      const timedFailedJobs = failedJobList.filter(j => j.submissionTime != null && j.completionTime != null);
      const avgJobDurationMs = timedFailedJobs.length > 0
        ? timedFailedJobs.reduce((s, j) => s + (j.completionTime! - j.submissionTime!), 0) / timedFailedJobs.length
        : 0;
      const totalJobs = completed.length;
      return {
        type: 'jobFailureRate', stageId: null,
        impactBand: rate >= thresholds.critRate ? 'critical' : rate >= thresholds.warnRate ? 'warning' : 'info',
        metric: 'jobFailureRate', value: Math.round(rate * 1000) / 10,
        failedJobs, totalJobs, failedTasks, totalTasks, avgJobDurationMs,
        taskFailureRate: Math.round(taskFailureRate * 1000) / 10,
        recommendation: `${failedJobs} of ${totalJobs} jobs never recovered: inspect the driver log for the failed job(s) and the stage failures that triggered them.`,
      };
    },
    estimate(finding): ImpactEstimate | null {
      const failedJobs = (finding.failedJobs as number | undefined) ?? 0;
      const avgJobDurationMs = (finding.avgJobDurationMs as number | undefined) ?? 0;
      const coreHoursIsh = (failedJobs * avgJobDurationMs) / 3.6e6;
      return costOnly('modeled', { value: coreHoursIsh, unit: 'coreHours' });
    },
  }),
  // ── Config-sanity entries (scope:'config', inScorecard:false) ────────────────
  defineConfigDetector({
    type: 'configAudit', order: 120, fixEffort: 'config', version: 1, inScorecard: false,
    emits: ['configAudit'],
    docAnchor: '#config-shuffle-service', thresholds: {}, property: 'spark.shuffle.service.enabled',
    detect(target): Finding | null {
      const res = target.app?.resources ?? null;
      if (res?.dynamicAllocationEnabled === true && res?.shuffleServiceEnabled === false) {
        return {
          type: 'configAudit', property: 'spark.shuffle.service.enabled',
          impactBand: 'warning', metric: 'config', valueText: 'false',
          recommendation: 'Dynamic allocation is on but the external shuffle service is off: set spark.shuffle.service.enabled=true so shuffle data survives executor removal.',
          remediation: setConfUnlessLogged(target.app, 'spark.shuffle.service.enabled', true),
        };
      }
      return null;
    },
    estimate: noWasteModel,
  }),
  defineConfigDetector({
    type: 'configAudit', order: 121, fixEffort: 'config', version: 1, inScorecard: false,
    emits: ['configAudit'],
    docAnchor: '#config-autoscale-bounds', thresholds: {}, property: 'spark.dynamicAllocation.maxExecutors',
    detect(target): Finding | null {
      const app = target.app; const config = app?.config ?? {}; const res = app?.resources ?? null;
      if (res?.dynamicAllocationEnabled !== true) return null;
      const minN = config['spark.dynamicAllocation.minExecutors'] != null ? parseInt(config['spark.dynamicAllocation.minExecutors'], 10) : null;
      const maxN = config['spark.dynamicAllocation.maxExecutors'] != null ? parseInt(config['spark.dynamicAllocation.maxExecutors'], 10) : null;
      if (minN != null && maxN != null && minN > maxN) {
        return {
          type: 'configAudit', property: 'spark.dynamicAllocation.minExecutors',
          impactBand: 'critical', metric: 'config', valueText: `${minN} > ${maxN}`,
          recommendation: `spark.dynamicAllocation.minExecutors (${minN}) exceeds maxExecutors (${maxN}): set min ≤ max.`,
          remediation: [decreaseConf('spark.dynamicAllocation.minExecutors', maxN)],
        };
      }
      if (maxN == null) {
        return {
          type: 'configAudit', property: 'spark.dynamicAllocation.maxExecutors',
          impactBand: 'info', metric: 'config', valueText: '(unset)',
          recommendation: 'Dynamic allocation is on with no upper bound: set spark.dynamicAllocation.maxExecutors to cap cluster growth.',
          remediation: [setConf('spark.dynamicAllocation.maxExecutors')],
        };
      }
      return null;
    },
    estimate: noWasteModel,
  }),
  defineConfigDetector({
    type: 'configAudit', order: 122, fixEffort: 'config', version: 1, inScorecard: false,
    emits: ['configAudit'],
    docAnchor: '#config-serializer', thresholds: {}, property: 'spark.serializer',
    detect(target): Finding | null {
      const app = target.app; const config = app?.config ?? {}; const res = app?.resources ?? null;
      if (Object.keys(config).length === 0) return null;
      const ser = res?.serializer ?? config['spark.serializer'] ?? null;
      const isKryo = typeof ser === 'string' && /kryo/i.test(ser);
      if (isKryo) return null;
      return {
        type: 'configAudit', property: 'spark.serializer',
        impactBand: 'info', metric: 'config', valueText: ser ?? '(default JavaSerializer)',
        recommendation: `Current serializer is ${ser ?? 'the default JavaSerializer'}: consider spark.serializer=org.apache.spark.serializer.KryoSerializer for faster, smaller buffers.`,
        remediation: setConfUnlessLogged(app, 'spark.serializer', 'org.apache.spark.serializer.KryoSerializer'),
      };
    },
    estimate: noWasteModel,
  }),
  defineConfigDetector({
    type: 'configAudit', order: 123, fixEffort: 'config', version: 1, inScorecard: false,
    emits: ['configAudit'],
    docAnchor: '#config-memory-overhead', thresholds: { floorMB: 384, floorPct: 0.1 }, property: 'spark.executor.memoryOverhead',
    detect(target, thresholds): Finding | null {
      const res = target.app?.resources ?? null;
      const memMB = res?.executor?.memoryMB ?? null;
      const ovMB = res?.executor?.memoryOverheadMB ?? null;
      if (memMB == null || ovMB == null) return null;
      const floor = Math.max(thresholds.floorMB, Math.round(memMB * thresholds.floorPct));
      if (ovMB >= floor) return null;
      return {
        type: 'configAudit', property: 'spark.executor.memoryOverhead',
        impactBand: 'info', metric: 'config', valueText: `${ovMB} MiB`,
        recommendation: `Executor memoryOverhead (${ovMB} MiB) is below Spark's default floor of ${floor} MiB (max of 384 MiB or 10% of executor memory): raise it to avoid off-heap OOM-kills.`,
        remediation: [increaseConf('spark.executor.memoryOverhead', `${floor}m`)],
      };
    },
    estimate: noWasteModel,
  }),
  // ── Plan-metric entries (scope:'sql') ────────────────────────────────────
  defineSqlDetector({
    type: 'duplicatePlanSubtree', order: 130, fixEffort: 'code', version: 2,
    emits: ['duplicatePlanSubtree'],
    docAnchor: '#bottleneck-duplicate-plan-subtree',
    // stageFloorPct: the 0.5% runtime floor. The claim counts at most each linked stage's own
    // task-active time, so a repeat whose stages together lasted less than this share of the run
    // graded info: 340 of 545 findings on the 14 real logs. The repeat is still in the plan; the
    // floor is why they're dropped. A repeat with no linked stage time is kept.
    thresholds: { minSubtreeSize: 3, minOccurrences: 2, stageFloorPct: 0.005 },
    detect(sqlExec, ctx, thresholds): Finding[] | null {
      if (!sqlExec.planTree) return null;
      const groups = findDuplicateSubtrees(sqlExec.planTree, thresholds);
      if (groups.length === 0) return null;
      const fallbackStageIds = stageIdsForSqlExec(sqlExec.id, ctx.stages);
      const executionNodes: PlanNode[] = [];
      walkPlanTree(sqlExec.planTree, (node) => executionNodes.push(node));
      const operatorsByStage = operatorCountByStage(executionNodes);
      const runMs = appDurationMs(ctx.app);
      const findings = groups.map((g): Finding | null => {
        const nodes: PlanNode[] = [];
        for (const n of g.nodes) walkPlanTree(n, (node) => nodes.push(node));
        const stageIds = unionStageIds(nodes, fallbackStageIds);
        let stagesMs = 0;
        for (const id of stageIds) {
          const stage = ctx.stages.get(id);
          if (stage) stagesMs += Math.max(0, (stage.completedAt ?? 0) - (stage.submittedAt ?? 0));
        }
        if (runMs != null && stagesMs > 0 && stagesMs < runMs * thresholds.stageFloorPct) return null;
        const occurrencesIdentical = occurrencesHaveIdenticalDetails(g.nodes);
        const stageShares = stageOperatorShares(nodes, operatorsByStage);
        // resolvePlanTree always sets id; safe downstream of it.
        const planNodeIds = nodes.map((n) => n.id!).filter(Boolean);
        const detail = duplicateSubtreeDetail({ ...g, value: g.occurrences });
        const differing = occurrencesIdentical ? '' : ` ${DUPLICATE_SUBTREE_DIFFERING_NOTE}`;
        return {
          type: 'duplicatePlanSubtree', executionId: sqlExec.id, stageIds, planNodeIds,
          stageShares, occurrencesIdentical,
          // Fixed fallback: overwritten by deriveImpactBand when this finding gets a real
          // wallClock estimate. Repeats with differing details get no estimate (nothing is
          // known to be recomputed), and neither does a subtree with no stage of its own.
          impactBand: occurrencesIdentical && Object.keys(stageShares).length > 0 ? 'warning' : 'info',
          metric: 'subtreeOccurrences', value: g.occurrences,
          rootName: g.rootName, subtreeSize: g.subtreeSize, sampleRelation: g.sampleRelation,
          groupIndex: g.groupIndex,
          confidence: occurrencesIdentical ? duplicateSubtreeConfidence(g.subtreeSize, g.occurrences, thresholds) : 'low',
          validationRequired: 'Matching compares operator and metric names only, not literals or expression IDs: confirm the repeat in the Spark UI SQL tab before acting.',
          recommendation: (g.isExchangeRoot
            ? `${detail}: this looks like a possible missed exchange reuse; check whether the same shuffle could be computed once and reused.`
            : `${detail}: consider caching/persisting the shared computation or check for a duplicated query branch.`) + differing,
        };
      }).filter((f): f is Finding => f !== null);
      return findings.length > 0 ? findings : null;
    },
    estimate(finding, ctx): ImpactEstimate | null {
      const stageIds = finding.stageIds as number[] | undefined;
      if (!stageIds || stageIds.length === 0) return null;
      // detect() reports subtreeOccurrences >= 2. Only repeats past the first are redundant:
      // computing the subtree once is real work, so waste is (occurrences-1)/occurrences of the stages' time.
      const occurrences = typeof finding.value === 'number' ? finding.value : 0;
      // Defensive only: minOccurrences guarantees occurrences >= 2 on real data; a malformed-value fallback.
      if (occurrences < 2) return costOnly('none');
      // Same-shaped repeats whose details differ compute different data: nothing is known to be
      // recomputed, so there is no time to claim.
      if (finding.occurrencesIdentical === false) return costOnly('none');
      // Each stage contributes the share of its operators inside the repeated subtree: a stage it
      // shares with other operators (the consuming join, the join's other side) isn't all its
      // time, and claiming whole stages let sibling groups claim the same stage twice. Findings
      // built without the field (hand-made fixtures) count every linked stage whole.
      const shares = (finding.stageShares ?? null) as Record<number, number> | null;
      const redundantFraction = (occurrences - 1) / occurrences;
      const wasteMsByStage = new Map<number, number>();
      for (const id of stageIds) {
        const s = ctx.stages.get(id);
        const share = shares ? (shares[id] ?? 0) : 1;
        if (s && share > 0) {
          // Time with tasks running, not submit-to-complete: a stage left waiting for cores
          // (2491s open, 60s of tasks on a real log) isn't recomputing anything while it waits.
          const activeMs = s.taskActiveMs ?? Math.max(0, (s.completedAt ?? 0) - (s.submittedAt ?? 0));
          wasteMsByStage.set(id, activeMs * share * redundantFraction);
        }
      }
      // No operator of the subtree ran in a known stage: no time to attribute.
      if (wasteMsByStage.size === 0) return costOnly('none');
      const totalWasteMs = [...wasteMsByStage.values()].reduce((sum, ms) => sum + ms, 0);
      const rawWaste: RawWasteFigure = { value: totalWasteMs, unit: 'ms' };
      return multiStageImpact([...wasteMsByStage.keys()], wasteMsByStage, ctx, 'measured', rawWaste)
        ?? costOnly('measured', rawWaste);
    },
  }),
  defineSqlDetector({
    type: 'smallFiles', order: 131, fixEffort: 'config', version: 2,
    emits: ['smallFiles'],
    docAnchor: '#bottleneck-small-files',
    thresholds: { minFiles: 100, maxAvgFileSizeMB: 3 },
    detect(sqlExec, ctx, thresholds): Finding[] | null {
      if (!sqlExec.planTree) return null;
      const { minFiles, maxAvgFileSizeMB } = thresholds;
      interface SmallFilesHit { direction: 'read' | 'write'; fileCount: number; avgBytes: number; nodeName: string; node: PlanNode; }
      const hits: SmallFilesHit[] = [];
      walkPlanTree(sqlExec.planTree, (node) => {
        const metrics = node.metrics ?? [];
        const byName = (name: string) => metrics.find(m => m.name === name);
        const checkSide = (
          countMetric: { name: string; value: number } | undefined,
          bytesMetric: { name: string; value: number } | undefined,
          direction: 'read' | 'write',
        ) => {
          if (!countMetric || !bytesMetric || !(countMetric.value > minFiles)) return;
          const avgBytes = bytesMetric.value / countMetric.value;
          if (!(avgBytes < maxAvgFileSizeMB * MB)) return;
          hits.push({ direction, fileCount: countMetric.value, avgBytes, nodeName: node.name, node });
        };
        checkSide(byName(FILES_READ_COUNT), byName(FILES_READ_BYTES), 'read');
        checkSide(byName(FILES_WRITTEN_COUNT), byName(FILES_WRITTEN_BYTES), 'write');
      });
      if (hits.length === 0) return null;
      const fallbackStageIds = stageIdsForSqlExec(sqlExec.id, ctx.stages);
      return hits.map(h => {
        const stageIds = unionStageIds([h.node], fallbackStageIds);
        const planNodeIds = h.node.id ? [h.node.id] : [];
        return {
          type: 'smallFiles', executionId: sqlExec.id, stageIds, planNodeIds,
          impactBand: 'warning',
          metric: 'avgFileSizeBytes', value: Math.round(h.avgBytes),
          fileCount: h.fileCount, direction: h.direction, nodeName: h.nodeName,
          recommendation: h.direction === 'read'
            ? `${h.fileCount} small files were read at ${pathBasename(h.nodeName)}: consider compacting the upstream output so fewer, larger files are produced.`
            : `${h.fileCount} small files were written at ${pathBasename(h.nodeName)}: repartition or coalesce before writing to raise the average file size.`,
        };
      });
    },
    estimate(finding, ctx): ImpactEstimate | null {
      const fileMs = ((finding.fileCount as number | undefined) ?? 0) * FILE_OPEN_OVERHEAD_MS;
      // A read's files are opened by the scan's tasks, in parallel: spread the per-file cost over
      // the most tasks its stages ran at once (91344 files x 10ms is 913s, claimed against a 117s
      // stage that ran 314 tasks at once). A write keeps the serial sum: the job commit moves each
      // output file on the driver, one after another.
      const stageIds = finding.stageIds as number[] | undefined;
      let slots = 1;
      if (finding.direction === 'read') {
        for (const id of stageIds ?? []) slots = Math.max(slots, ctx.stages.get(id)?.peakConcurrentTasks ?? 1);
      }
      return stageMappableWasteOrCostOnly(fileMs / slots, stageIds, ctx);
    },
  }),
  defineSqlDetector({
    // Entry-level type is an identifier only; it never appears on an emitted finding. Findings
    // carry 'underBroadcast'/'overBroadcast' since one shared plan-walk covers both
    // opposite-direction rules (JoinToBroadcastAlert / BroadcastTooLargeAlert).
    type: 'broadcastSizing', order: 132, fixEffort: 'config', version: 2,
    // Listed over-first: the two share order 132, and this list order is their display tie-break.
    emits: ['overBroadcast', 'underBroadcast'],
    docAnchor: '#bottleneck-broadcast-sizing',
    thresholds: {
      broadcastTiers: [10 * MB, 100 * MB, GB, 5 * GB],
      comparisonTiers: [10 * GB, 300 * GB, TB],
      overBroadcastBytes: GB,
    },
    detect(sqlExec, ctx, thresholds): Finding[] | null {
      if (!sqlExec.planTree) return null;
      const { broadcastTiers, comparisonTiers, overBroadcastBytes } = thresholds;
      const fallbackStageIds = stageIdsForSqlExec(sqlExec.id, ctx.stages);
      const out: Finding[] = [];
      walkPlanTree(sqlExec.planTree, (node) => {
        if (node.name === 'SortMergeJoin' && (node.children ?? []).length === 2) {
          const [childA, childB] = node.children;
          const a = sumBoundarySize(childA);
          const b = sumBoundarySize(childB);
          const smaller = Math.min(a, b);
          const larger = Math.max(a, b);
          if (smaller > 0) {
            const fires = smaller < broadcastTiers[0]
              || (smaller < broadcastTiers[1] && larger > comparisonTiers[0])
              || (smaller < broadcastTiers[2] && larger > comparisonTiers[1])
              || (smaller < broadcastTiers[3] && larger > comparisonTiers[2]);
            if (fires) {
              const contributors = [...boundarySizeContributors(childA), ...boundarySizeContributors(childB)];
              // A threshold that already admits the smaller side cannot be what stopped the broadcast.
              const threshold = effectiveBroadcastThreshold(ctx.app);
              const broadcastThreshold: BroadcastThreshold = threshold != null && threshold < 0 ? 'disabled'
                : threshold != null && threshold > smaller ? 'notLimiting' : 'limits';
              const raiseAdvice = 'Consider a broadcast() hint or raising spark.sql.autoBroadcastJoinThreshold.';
              out.push({
                type: 'underBroadcast', executionId: sqlExec.id, stageIds: unionStageIds(contributors, fallbackStageIds),
                // resolvePlanTree always sets id; safe downstream of it.
                planNodeIds: contributors.map((n) => n.id!).filter(Boolean),
                impactBand: 'info', metric: 'smallerSideBytes', value: smaller,
                largerSideBytes: larger, broadcastThreshold,
                recommendation: broadcastThreshold === 'notLimiting'
                  ? `The smaller input to this Sort Merge Join (${formatBytes(smaller)}) is under the effective spark.sql.autoBroadcastJoinThreshold (${formatBytes(threshold!)}) yet was not broadcast (the larger side is ${formatBytes(larger)}), so the threshold is not what stopped it: missing table statistics or a join type that cannot broadcast usually is. Consider a broadcast() hint or collecting statistics (ANALYZE TABLE).`
                  : `The smaller input to this Sort Merge Join (${formatBytes(smaller)}) is well under the broadcast threshold relative to the larger side (${formatBytes(larger)}): this could have been a broadcast join. ${raiseAdvice}`,
                remediation: broadcastThreshold === 'notLimiting' ? [] : [increaseConf('spark.sql.autoBroadcastJoinThreshold')],
              });
            }
          }
        }
        if (isBroadcastExchangeNode(node.name)) {
          const m = (node.metrics ?? []).find(x => x.name === 'data size');
          if (m && m.value > overBroadcastBytes) {
            // BroadcastExchange's own metrics are driver-computed and never on any TaskEnd
            // (node.stageIds always empty in real data); its child carries the executor-side
            // metrics, so only the child unions in.
            const child = (node.children ?? [])[0];
            // A threshold below the broadcast cannot have admitted it, so a hint forced it.
            const threshold = effectiveBroadcastThreshold(ctx.app);
            const autoBroadcastOff = threshold != null && threshold < 0;
            const hintForced = autoBroadcastOff || (threshold != null && m.value > threshold);
            const broadcastThreshold: BroadcastThreshold = autoBroadcastOff ? 'disabled' : hintForced ? 'notLimiting' : 'limits';
            out.push({
              type: 'overBroadcast', executionId: sqlExec.id,
              stageIds: unionStageIds(child ? [child] : [], fallbackStageIds),
              // resolvePlanTree always sets id; safe downstream of it.
              planNodeIds: [node.id!].filter(Boolean),
              impactBand: 'warning', metric: 'broadcastBytes', value: m.value, broadcastThreshold,
              recommendation: autoBroadcastOff
                ? `This broadcast (${formatBytes(m.value)}) exceeds the ${binaryThresholdLabel(overBroadcastBytes)} threshold: automatic broadcast is already disabled, so remove the broadcast() hint that forced it.`
                : hintForced
                  ? `This broadcast (${formatBytes(m.value)}) exceeds the ${binaryThresholdLabel(overBroadcastBytes)} threshold: spark.sql.autoBroadcastJoinThreshold (${formatBytes(threshold!)}) is below it, so a broadcast() hint forced it: remove the hint.`
                  : `This broadcast (${formatBytes(m.value)}) exceeds the ${binaryThresholdLabel(overBroadcastBytes)} threshold: check for a misapplied broadcast hint or a misconfigured spark.sql.autoBroadcastJoinThreshold.`,
              remediation: hintForced ? [] : [decreaseConf('spark.sql.autoBroadcastJoinThreshold')],
            });
          }
        }
      });
      return out.length ? out : null;
    },
    estimate(finding, ctx): ImpactEstimate | null {
      // Both finding types carry bytes as `value`: overBroadcast's broadcastBytes, underBroadcast's
      // smallerSideBytes (the smaller join side), each priced as one broadcast transfer.
      const wasteMs = (((finding.value as number | undefined) ?? 0) / BROADCAST_BANDWIDTH_BPS) * 1000;
      return stageMappableWasteOrCostOnly(wasteMs, finding.stageIds as number[] | undefined, ctx);
    },
  }),
] as const satisfies readonly Detector[];

/** The entry that emits each finding type: the one whose estimate prices it and whose thresholds
 * and order describe it. Several entries can emit one type (the four configAudit audits), and the
 * first declared wins. */
export const ENTRY_BY_TYPE: ReadonlyMap<string, Detector> = (() => {
  const byType = new Map<string, Detector>();
  for (const entry of DETECTORS as readonly Detector[]) {
    for (const type of entry.emits) if (!byType.has(type)) byType.set(type, entry);
  }
  return byType;
})();

/** A `DETECTORS` entry's own `type`: every emitted finding type, plus broadcastSizing. */
export type DetectorType = (typeof DETECTORS)[number]['type'];

/** Every finding `type` a detector can emit, from the entries' `emits` lists. */
export type FindingType = (typeof DETECTORS)[number]['emits'][number];

type DetectorEntry = (typeof DETECTORS)[number];
type EntryEmitting<T extends FindingType, D extends DetectorEntry = DetectorEntry> =
  D extends { emits: readonly (infer E)[] } ? (T extends E ? D : never) : never;

/** The `thresholds` of the entry (or entries, for configAudit) that emit finding type `T`. */
export type ThresholdsOf<T extends FindingType> = EntryEmitting<T>['thresholds'];

// `emits` already only names Finding members (Detector.emits); this makes the reverse hold too, so a
// Finding member no detector emits, or a detector whose type has no Finding member, fails to compile.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
export type FindingTypesMatchDetectors = AssertTrue<SameUnion<FindingType, Finding['type']>>;

// A `suppressedBy` that names no entry would never suppress anything; this makes it a compile error.
// An entry without one infers the bare `string` constraint, which contributes nothing here.
type DeclaredSuppressor<D> = D extends { suppressedBy?: infer S } ? (string extends S ? never : S) : never;
type SuppressorType = NonNullable<DeclaredSuppressor<DetectorEntry>>;
export type SuppressorsAreDetectors = AssertTrue<[SuppressorType] extends [DetectorType] ? true : false>;

/** Per-detector threshold overrides, keyed by entry `type`: each value a partial of that entry's
 * own thresholds. Built by threshold-overrides.ts from a user's config file. */
export type ThresholdOverrides = {
  readonly [D in DetectorEntry as D['type']]?: Partial<D['thresholds']>;
};
