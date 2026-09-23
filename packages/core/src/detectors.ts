import { pathBasename, formatBytes, nsToMs, IMPACT_BAND_ORDER } from './format-utils.ts';
import { scanRelationId } from './plan-summary.ts';
import { computePeakConcurrentCores, computePeakConcurrentExecutorCount } from './core-count.ts';
import { walkPlanTree } from './plan-tree-walk.ts';
import { computeCoreLocalityRatio } from './core-locality-ratio.ts';
import { estimateSingleStage, type OccupancyStage, type StageOccupancyInfo } from './occupancy.ts';
import { isExchangeNode, isBroadcastExchangeNode } from './plan-node-detail.ts';
import type { Finding, PlanNode, FixEffort } from './types.ts';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const TB = 1024 * GB;

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
interface DetectorFailedTaskSample {
  taskId: number | null;
  attemptNumber: number;
  host: string;
  executorId: string;
  reason: string | null;
  peakExecMem: number;
  memSpilled: number;
  shuffleWrite: number;
}
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
  localityStats?: DetectorLocalityStat[];
  stragglerCount: number;
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
  rddInfo?: Map<number, DetectorRddInfo>;
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

// The full context analyze() passes as every stage/sql detect()'s second arg, and as the sole
// arg for 'app' scope. 'config' scope gets a narrower `{ app }` (auditConfig), typed per-entry.
//
// `app` is typed as non-nullable here (unlike AppModel.app), but incompleteRun, coldStart,
// utilization, and autoscalingChurn defensively guard against null at runtime to tolerate
// malformed/incomplete logs. Despite the type annotation, app may be null in edge cases, and
// these detectors handle it gracefully. auditConfig's config-scope target keeps `app` nullable
// instead.
export interface DetectorCtx {
  app: DetectorApp;
  stages: Map<number, DetectorStage>;
  executorsAdded: DetectorExecutorAddedEvent[];
  executorsRemoved: DetectorExecutorRemovedEvent[];
  jobs: Map<number, DetectorJob>;
  sql: Map<number, DetectorSqlExec>;
  runAggregates?: { busyCoreMs: number } | null;
  // Precomputed once per analyze() from the same stages/totalCores impact-estimator.ts uses,
  // so a detector's runtime floor checks the same occupancy-clipped figure that gets displayed.
  occupancy: Map<number, StageOccupancyInfo>;
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

// Shared by every scope:'sql' detector. sql.get(id).stageIds is always empty (parser-worker
// never populates it), so stage linkage is derived from each stage's own sqlExecutionId.
// Minimal param shape (not DetectorStage): external callers pass Map<StageId, Stage>.
export function stageIdsForSqlExec(
  executionId: number,
  stages: Map<number, { id: number; sqlExecutionId?: number | null }>,
): number[] {
  const out: number[] = [];
  for (const s of stages.values()) if (s.sqlExecutionId === executionId) out.push(s.id);
  return out;
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
// fingerprint encodes operator name + sorted metric NAMES (never values, per spec) + child
// fingerprints, so two subtrees with the same shape but different values still collide.
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
    const childFingerprints = childShapes.map((c) => c.fingerprint).join(',');
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
  s = s.replace(/([A-Za-z_][\w.]*)\s*=\s*([A-Za-z_][\w.]*)/g, (_m, l, r) => {
    const [a, b] = [l, r].sort();
    return `${a} = ${b}`;
  });
  return s;
}

const JOIN_NAME_RE = /Join/i;

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
    const childFingerprints = childResults.map((r) => r.fingerprint).join(',');
    const fingerprint = `${node.name}[${metricNames}]{${childFingerprints}}`;

    const leafRelationBytes = new Map<string, number>();
    const rid = scanRelationId(node.name ?? '', node.detail ?? '');
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
    found = scanRelationId(n.name ?? '', n.detail ?? '');
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
  const median = vals[Math.floor(vals.length / 2)];
  if (median <= 0) return null;
  const top = samples.reduce((a, b) => (b.value > a.value ? b : a));
  return { key: top.key, ratio: top.value / median, value: top.value };
}

export interface DetectorCatalogEntry {
  type: string;
  version: number;
  scope: 'stage' | 'sql' | 'app' | 'config';
  thresholds?: Record<string, number | number[]>;
  docAnchor?: string;
}

// Machine-readable detector metadata for the evidence report (no `detect` closure), so a
// portable report records which detector + thresholds produced each finding.
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
// floor can't scale. Used by skew/straggler, gated via clippedWasteMs against the same
// occupancy-clipped figure impact-estimator.ts displays as savings.
// NOT SOURCED: floor percentages are our own noise floor, unvalidated.
function computeAppDurationMs(ctx?: DetectorCtx): number | null {
  const app = ctx?.app;
  if (app?.startTime == null || app?.endTime == null) return null;
  const durationMs = app.endTime - app.startTime;
  return durationMs > 0 ? durationMs : null;
}

// Unknown app timing never suppresses a finding; it just skips the floor gate.
function meetsRuntimeFloor(wasteMs: number, appDurationMs: number | null, floorPct: number): boolean {
  return appDurationMs == null || wasteMs >= appDurationMs * floorPct;
}

// Runs a raw waste delta through the same occupancy clip impact-estimator.ts applies before
// display, so the runtime floor checks recoverable wall-clock, not a delta a physical floor
// leaves unrecoverable. Falls back to the raw delta when occupancy data is unavailable.
// skew/straggler claims shorten the stage's longest task, hence shortensLongestTask (see occupancy.ts).
function clippedWasteMs(wasteMs: number, stageId: number, ctx?: DetectorCtx): number {
  if (!ctx) return wasteMs;
  const est = estimateSingleStage(
    wasteMs, stageId, ctx.stages as unknown as Map<number, OccupancyStage>, ctx.occupancy, { shortensLongestTask: true },
  );
  return est ? est.wallClock.high : wasteMs;
}

// Shared by cacheUtilization's two variants: the ratio is a point-in-time storage snapshot from
// stage-submission events, not a runtime block-access read-count.
const CACHE_UTILIZATION_VALIDATION =
  "This ratio is a point-in-time storage snapshot from stage-submission events, not a runtime read-count. Confirm against the Spark UI's Storage tab before acting.";

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

function partialCacheFinding(rdd: DetectorRddInfo, cachedRatio: number, impactBand: 'warning' | 'info'): Finding {
  const rddName = rdd.name || `RDD ${rdd.id}`;
  const cachedPct = Math.round(cachedRatio * 100);
  const evictedPct = 100 - cachedPct;
  return {
    type: 'cacheUtilization', variant: 'partialCache', stageId: null,
    rddId: rdd.id, rddName,
    impactBand, metric: 'cachedRatio', value: cachedPct,
    confidence: cacheSampleConfidence(rdd.numPartitions),
    validationRequired: CACHE_UTILIZATION_VALIDATION,
    memorySize: rdd.memorySize, diskSize: rdd.diskSize,
    numCachedPartitions: rdd.numCachedPartitions, numPartitions: rdd.numPartitions,
    recommendation: `RDD ${rddName} is ${evictedPct}% evicted from cache (${cachedPct}% of partitions cached). Increase executor memory or reduce the cached dataset size.`,
  };
}

function diskSpilloverFinding(rdd: DetectorRddInfo, diskRatio: number, impactBand: 'warning' | 'info'): Finding {
  const rddName = rdd.name || `RDD ${rdd.id}`;
  const diskPct = Math.round(diskRatio * 100);
  return {
    type: 'cacheUtilization', variant: 'diskSpillover', stageId: null,
    rddId: rdd.id, rddName,
    impactBand, metric: 'diskRatio', value: diskPct,
    confidence: cacheSampleConfidence(rdd.numPartitions),
    validationRequired: CACHE_UTILIZATION_VALIDATION,
    memorySize: rdd.memorySize, diskSize: rdd.diskSize,
    numCachedPartitions: rdd.numCachedPartitions, numPartitions: rdd.numPartitions,
    recommendation: `RDD ${rddName} is ${diskPct}% spilled to disk despite requesting MEMORY_AND_DISK. Executor memory may be too small for this cached dataset.`,
  };
}

// Entry shape for every DETECTORS item. TTarget stays `unknown` at the array level: detect's
// real first-arg varies by scope (DetectorStage/DetectorSqlExec/DetectorCtx/{ app }), and
// unifying them would need an unsound cast or a discriminated-union redesign. Each entry gets a
// precise detect by annotating its own params: object-literal method params are checked
// bivariantly, so a narrower annotation here doesn't conflict with the `unknown` declaration.
export interface Detector<TTarget = unknown> {
  type: string;
  scope: 'stage' | 'sql' | 'app' | 'config';
  order: number;
  fixEffort: FixEffort;
  version: number;
  docAnchor?: string;
  // number[] too: slowHost's ratioTiers and broadcastSizing's tiers are genuine tier tables.
  thresholds?: Record<string, number | number[]>;
  recommendation?: string;
  confidence?: string;
  validationRequired?: string;
  inScorecard?: boolean;
  property?: string;
  suppressWhen?: (finding: Finding, out: Finding[]) => boolean;
  detect(target: TTarget, ctx?: unknown): Finding | Finding[] | null;
}

// Threshold field naming convention:
// *Pct = 0–1 fraction (normalized)
// *Pct100 = 0–100 scale
// *Ratio = multiplicative factor
// *Share/*Rate/*Util = 0–1 fraction (normalized)

// straggler's noise-floor thresholds (NOT SOURCED: unvalidated), exported so impact-band.ts
// reuses the same figures instead of hand-copying.
export const STRAGGLER_FLOOR_PCT_WARN = 0.005;
export const STRAGGLER_FLOOR_PCT_CRIT = 0.02;

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

export const DETECTORS: Detector[] = [
  {
    type: 'skew', scope: 'stage', order: 30, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-skew',
    thresholds: { ratioWarn: 3, minTasksForP95: 20, floorPctWarn: 0.005 },
    detect(
      this: {
        thresholds: { ratioWarn: number; minTasksForP95: number; floorPctWarn: number };
      },
      stage: DetectorStage,
      ctx?: DetectorCtx,
    ): Finding | null {
      const result = computeSkewRatio(stage, this.thresholds.minTasksForP95);
      if (result === null) return null;
      const { ratio, metric } = result;
      if (ratio <= this.thresholds.ratioWarn) return null;
      // Same absolute delta impact-estimator.ts's 'skew' case reports as savings; clipped the
      // same way before the floor check so the gate agrees with what's displayed.
      const wasteMs = Math.max(0, metric === 'P95/median' ? stage.taskDurationP95 - stage.taskDurationP50 : stage.taskDurationMax - stage.taskDurationP50);
      const appDurationMs = computeAppDurationMs(ctx);
      const floorWasteMs = clippedWasteMs(wasteMs, stage.id, ctx);
      if (!meetsRuntimeFloor(floorWasteMs, appDurationMs, this.thresholds.floorPctWarn)) return null;
      const value = Math.round(ratio * 10) / 10;
      return {
        type: 'skew', stageId: stage.id,
        impactBand: 'warning',
        metric, value,
        confidence: skewConfidence(ratio, this.thresholds.ratioWarn),
        validationRequired: 'This finding is gated by a 0.5% runtime-floor threshold, our own noise floor for this metric.',
        recommendation: `Task duration ratio (${metric}) is ${value}×: for join-driven skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key to reduce task skew.`,
      };
    },
  },
  {
    type: 'stageShape', scope: 'stage', order: 35, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-stage-shape',
    thresholds: { pRatioMax: 0.5, oiRatioMax: 10, skewWarn: 3 },
    detect(
      this: { thresholds: { pRatioMax: number; oiRatioMax: number; skewWarn: number } },
      stage: DetectorStage,
      ctx?: DetectorCtx,
    ): Finding[] {
      const out: Finding[] = [];
      const execCount = (stage.executorStats ?? []).length;
      const cores = ctx?.app?.resources?.executor?.cores ?? 1;
      const totalCores = execCount * cores;
      // PRatio: under-parallelization.
      if (totalCores > 0) {
        const pRatio = stage.taskCount / totalCores;
        if (pRatio < this.thresholds.pRatioMax) {
          out.push({
            type: 'stageShape', stageId: stage.id, impactBand: 'info',
            rule: 'lowParallelism', metric: 'pRatio', value: Math.round(pRatio * 100) / 100,
            // Absolute core count behind pRatio, for the impact estimator's idle-core-ms figure.
            totalCores,
            recommendation: `This stage runs ${stage.taskCount} ${stage.taskCount === 1 ? 'task' : 'tasks'} across ~${totalCores} cores, so it is under-parallelized and leaves cluster capacity idle.`,
          });
        }
      }
      // OIRatio: data explosion. Skip when inputBytes is 0 (Infinity guard).
      if (stage.inputBytes > 0) {
        const oiRatio = stage.outputBytes / stage.inputBytes;
        if (oiRatio > this.thresholds.oiRatioMax) {
          out.push({
            type: 'stageShape', stageId: stage.id, impactBand: 'info',
            rule: 'dataExplosion', metric: 'oiRatio', value: Math.round(oiRatio * 10) / 10,
            recommendation: `This stage outputs ${Math.round(oiRatio)}× its input volume: check for an exploding join or a cross product.`,
          });
        }
      }
      // TaskStageSkew: straggler cost vs stage wall-clock. Skip near-zero duration. Always info
      // like its siblings: this trigger forces the occupancy-clipped estimate to exactly zero on
      // every firing, so there's no wall-clock-backed tier left to gate on.
      const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
      if (stageDurationMs > 0) {
        const ratio = stage.taskDurationMax / stageDurationMs;
        if (ratio > this.thresholds.skewWarn) {
          out.push({
            type: 'stageShape', stageId: stage.id, impactBand: 'info',
            rule: 'taskStageSkew', metric: 'taskStageSkew', value: Math.round(ratio * 10) / 10,
            // Absolute core count, for the impact estimator's idle-core-ms figure.
            totalCores,
            recommendation: `One task takes ${Math.round(ratio * 10) / 10}× this stage's wall-clock duration; a single straggler is gating the whole stage.`,
          });
        }
      }
      return out;
    },
  },
  {
    type: 'shuffle', scope: 'stage', order: 20, fixEffort: 'config', version: 1,
    docAnchor: '#bottleneck-shuffle',
    thresholds: { minBytes: 50 * MB },
    detect(
      this: { thresholds: { minBytes: number } },
      stage: DetectorStage,
    ): Finding | null {
      const bytes = stage.shuffleReadBytes;
      if (bytes <= this.thresholds.minBytes) return null;
      return {
        type: 'shuffle', stageId: stage.id,
        impactBand: 'info',
        metric: 'shuffleReadBytes', value: bytes,
        recommendation: `${formatBytes(bytes)} shuffled in this stage: consider increasing spark.sql.shuffle.partitions or adding a broadcast join.`,
      };
    },
  },
  {
    type: 'partitionSizing', scope: 'stage', order: 22, fixEffort: 'config', version: 1,
    docAnchor: '#bottleneck-shuffle',
    thresholds: { skewRatio: 5, skewFloorBytes: 256 * MB, lowParTotalBytes: GB, lowParMaxTasks: 7, maxPartBytes: 5 * GB },
    detect(
      this: {
        thresholds: {
          skewRatio: number; skewFloorBytes: number; lowParTotalBytes: number;
          lowParMaxTasks: number; maxPartBytes: number;
        };
      },
      stage: DetectorStage,
    ): Finding[] {
      const out: Finding[] = [];
      const { shuffleReadP50: p50, shuffleReadMax: max, shuffleReadBytes: total, taskCount } = stage;
      if (max > this.thresholds.skewRatio * p50 && max > this.thresholds.skewFloorBytes) {
        // p50 can be 0 (over half the shuffle partitions empty): a ratio against zero renders
        // "Infinity×", so fall back to median-free phrasing.
        const ratioText = p50 > 0
          ? `${Math.round(max / p50 * 10) / 10}× the median (${formatBytes(p50)})`
          : `far larger than the median (${formatBytes(p50)}, effectively empty)`;
        out.push({
          type: 'partitionSizing', stageId: stage.id, impactBand: 'warning',
          rule: 'shufflePartitionSkew', metric: 'shuffleReadMax', value: max,
          recommendation: `The largest shuffle partition (${formatBytes(max)}) is ${ratioText}: for join skew, enable AQE skew-join handling (spark.sql.adaptive.skewJoin.enabled); otherwise salt the key or repartition on a better key.`,
        });
      }
      if (total >= this.thresholds.lowParTotalBytes && taskCount <= this.thresholds.lowParMaxTasks) {
        out.push({
          type: 'partitionSizing', stageId: stage.id, impactBand: 'warning',
          rule: 'lowShuffleParallelism', metric: 'taskCount', value: taskCount,
          recommendation: `${Math.round(total / GB * 10) / 10} GB of shuffle spread over only ${taskCount} tasks: raise spark.sql.shuffle.partitions so each partition is smaller.`,
        });
      }
      if (max >= this.thresholds.maxPartBytes) {
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
  },
  {
    type: 'spill', scope: 'stage', order: 10, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-spill',
    thresholds: { singleTaskDiskGiB: 1, singleTaskMemGiB: 4, highDiskGiB: 1, highTaskDiskMB: 512, highMemGiB: 4, medDiskMB: 256, medMemGiB: 1, skewRatio: 5, skewDiskFloorMB: 128, skewMemFloorMB: 256, skewMinTasks: 10 },
    detect(this: { thresholds: SpillThresholds }, stage: DetectorStage): Finding | null {
      if (stage.memoryBytesSpilled === 0) return null;
      const cls = stage.spillClassification;
      const classified = cls === 'skew' || cls === 'volume';
      const mag = computeSpillMagnitude(stage, this.thresholds);
      const impactBand = 'warning';
      return {
        type: 'spill', stageId: stage.id, impactBand,
        spillMagnitude: mag?.magnitude,
        metric: 'memoryBytesSpilled', value: stage.memoryBytesSpilled,
        confidence: classified ? 'medium' : 'low',
        validationRequired: classified
          ? 'Spill cause is inferred from the share of tasks that spilled: confirm against per-task spill metrics in the Spark UI.'
          : 'Spill cause could not be classified: inspect per-task spill metrics in the Spark UI before acting.',
        recommendation: cls === 'skew'
          ? `${formatBytes(stage.memoryBytesSpilled)} spilled, skew-driven: fix task skew first; adding memory will not help.`
          : `${formatBytes(stage.memoryBytesSpilled)} spilled: raise spark.sql.shuffle.partitions or increase executor memory.`,
      };
    },
  },
  {
    type: 'gc', scope: 'stage', order: 50, fixEffort: 'config', version: 1,
    docAnchor: '#bottleneck-gc',
    validationRequired: 'This finding is gated by a 10-second minimum-runtime floor, our own noise floor for this metric.',
    thresholds: {
      warnPct100: 10,
      // Descending tier: ExecutorGcHeuristic, ported as-is.
      lowInfoPct100: 5,
      // NOT SOURCED: our own noise floor so a stage that barely ran doesn't flag either direction.
      minRunTimeMs: 10000,
    },
    detect(
      this: {
        thresholds: { warnPct100: number; lowInfoPct100: number; minRunTimeMs: number };
        validationRequired: string;
      },
      stage: DetectorStage,
    ): Finding | null {
      const pct = stage.gcPct;
      if ((stage.executorRunTime ?? 0) >= this.thresholds.minRunTimeMs
          && pct > this.thresholds.warnPct100) {
        const value = Math.round(pct * 10) / 10;
        return {
          type: 'gc', stageId: stage.id,
          impactBand: 'warning',
          metric: 'gcPct', value,
          confidence: gcConfidence(pct, this.thresholds, 'high'), validationRequired: this.validationRequired,
          recommendation: `GC consumed ${value}% of executor run time: reduce object creation, use primitive types, avoid UDFs, increase executor memory.`,
        };
      }
      // Low-GC (cost) branch: only for stages that ran long enough to be meaningful.
      if ((stage.executorRunTime ?? 0) >= this.thresholds.minRunTimeMs
          && pct < this.thresholds.lowInfoPct100) {
        const value = Math.round(pct * 10) / 10;
        return {
          type: 'gc', stageId: stage.id, direction: 'low',
          impactBand: 'info',
          metric: 'gcPct', value,
          confidence: gcConfidence(pct, this.thresholds, 'low'), validationRequired: this.validationRequired,
          recommendation: `GC consumed only ${value}% of executor run time: memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.`,
        };
      }
      return null;
    },
  },
  {
    type: 'slowHost', scope: 'stage', order: 60, fixEffort: 'config', version: 1,
    docAnchor: '#bottleneck-slow-host',
    thresholds: {
      minHosts: 3, minTasks: 15, ratioWarn: 2.0, minShare: 0.20, shareWarn: 0.75, taskShareWarn: 0.50, ratioTiers: [1.33, 1.78, 3.16, 10],
      // Absolute-magnitude floors (mirrors computeSpillMagnitude's ratio+floor pattern): on short
      // stages, sub-second/sub-64MB host differences produce huge noise ratios. 1s is above
      // per-task jitter but below genuine slow-host stages; 64MB mirrors the spill disk-skew floor.
      floorMs: 1000, floorBytes: 64 * MB,
    },
    detect(
      this: {
        thresholds: {
          minHosts: number; minTasks: number; ratioWarn: number; minShare: number;
          shareWarn: number; taskShareWarn: number; ratioTiers: number[]; floorMs: number; floorBytes: number;
        };
      },
      stage: DetectorStage,
    ): Finding[] | null {
      const hosts = stage.hostStats ?? [];
      const execs0 = stage.executorStats ?? [];
      if ((hosts.length < this.thresholds.minHosts && execs0.length < this.thresholds.minHosts) || stage.taskCount < this.thresholds.minTasks) return null;
      const out: Finding[] = [];
      if (hosts.length >= this.thresholds.minHosts) {
        const means = hosts.map(h => ({ host: h.host, taskCount: h.taskCount, mean: h.totalDuration / h.taskCount }));
        const sorted = [...means].map(h => h.mean).sort((a, b) => a - b);
        const overallMedian = sorted[Math.floor(sorted.length / 2)];
        if (overallMedian > 0) {
          for (const h of means) {
            const ratio = h.mean / overallMedian;
            const share = h.taskCount / stage.taskCount;
            if (ratio < this.thresholds.ratioWarn || share < this.thresholds.minShare || h.mean < this.thresholds.floorMs) continue;
            out.push({
              type: 'slowHost', stageId: stage.id,
              impactBand: 'warning',
              metric: 'hostMeanRatio', value: Math.round(ratio * 10) / 10,
              // `value` is a ratio; the estimator needs the absolute per-host mean.
              hostMeanMs: h.mean,
              host: h.host, hostTaskShare: Math.round(share * 100) / 100,
              recommendation: `${h.host} may just hold data locality for its tasks or carry one heavy stage, not necessarily a hardware fault: check what it was running, and consider enabling spark.speculation to relaunch a lagging task automatically.`,
            });
          }
        }
        const totalDuration = hosts.reduce((s, h) => s + h.totalDuration, 0);
        if (totalDuration > 0) {
          for (const h of hosts) {
            const durationShare = h.totalDuration / totalDuration;
            const taskShare = h.taskCount / stage.taskCount;
            if (durationShare >= this.thresholds.shareWarn && taskShare >= this.thresholds.taskShareWarn) {
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
      const tiers = this.thresholds.ratioTiers;
      const impactBandFor = (r: number): 'critical' | 'warning' | 'info' | null =>
        r >= tiers[3] ? 'critical' : (r >= tiers[1] ? 'warning' : (r >= tiers[0] ? 'info' : null));
      const floorMs = this.thresholds.floorMs, floorBytes = this.thresholds.floorBytes;
      const dims: { dimension: string; floor: number; samples: { key: string; value: number }[] }[] = [
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
          recommendation: `Executor ${r.key} deviates ${Math.round(r.ratio * 10) / 10}× from the median on ${d.dimension}: investigate uneven partition assignment or a degraded executor.`,
        });
      }
      return out;
    },
  },
  {
    type: 'stageSlowness', scope: 'stage', order: 65, fixEffort: 'code', version: 2,
    docAnchor: '#bottleneck-stage-slowness',
    thresholds: { infoMin: 15 },
    // Cross-detector suppression (see "Detector contract" in detector-contract.md). Requires this
    // entry to be declared AFTER slowHost in DETECTORS so slowHost findings are already in `out`.
    suppressWhen(finding, out) {
      return out.some(o => o.type === 'slowHost' && o.stageId === finding.stageId);
    },
    detect(
      this: { thresholds: { infoMin: number } },
      stage: DetectorStage,
    ): Finding | null {
      // Basis is real wall-clock stage duration, not per-executor average; the impact-estimator
      // formula reuses this exact stageDurationMs computation.
      const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
      if (!(stageDurationMs > 0)) return null;
      const durationMinutes = stageDurationMs / 60000;
      const t = this.thresholds;
      const impactBand = durationMinutes >= t.infoMin ? 'info' : null;
      if (!impactBand) return null;
      const value = Math.round(durationMinutes * 10) / 10;
      return {
        type: 'stageSlowness', stageId: stage.id, impactBand,
        metric: 'stageDurationMinutes', value,
        recommendation: `This stage ran ${value} minutes with no more specific cause flagged: often a partition-count problem, raise parallelism via spark.sql.shuffle.partitions or spark.default.parallelism, or check for a large per-task data volume driving heavy shuffle and spill.`,
      };
    },
  },
  {
    type: 'stageFailed', scope: 'stage', order: 42, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-failures',
    thresholds: {},
    detect(stage: DetectorStage): Finding | null {
      if (stage.stageFailureReason == null) return null;
      return {
        type: 'stageFailed', stageId: stage.id, impactBand: 'critical',
        variant: 'stageFailure',
        metric: 'stageFailureReason', value: stage.stageFailureReason,
        numTasks: stage.taskCount,
        memoryBytesSpilled: stage.memoryBytesSpilled,
        failedTaskDetails: stage.failedTaskSamples ?? [],
        recommendation: `This stage attempt failed outright. Inspect the driver log for the failure reason and the job that triggered it.`,
      };
    },
  },
  {
    type: 'failures', scope: 'stage', order: 40, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-failures',
    thresholds: { minTasks: 10, warnRate: 0.05, critRate: 0.20 },
    detect(
      this: { thresholds: { minTasks: number; warnRate: number; critRate: number } },
      stage: DetectorStage,
    ): Finding | null {
      if (stage.taskCount < this.thresholds.minTasks) return null;
      if (!stage.failedTasks) return null;
      const failureRate = stage.failedTasks / stage.taskCount;
      if (failureRate <= this.thresholds.warnRate) return null;
      const value = Math.round(failureRate * 1000) / 10;
      const dominantReason = pickDominantReason(stage.failureReasons);
      return {
        type: 'failures', stageId: stage.id,
        impactBand: failureRate > this.thresholds.critRate ? 'critical' : 'warning',
        metric: 'failureRate', value,
        failedTasks: stage.failedTasks,
        dominantReason,
        recommendation: `${value}% of tasks failed${dominantReason ? ` (dominant reason: ${dominantReason})` : ''}: investigate driver logs for executor instability or data-driven errors.`,
      };
    },
  },
  {
    type: 'straggler', scope: 'stage', order: 70, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-straggler',
    // floorPctWarn/floorPctCrit are re-exported as STRAGGLER_FLOOR_PCT_WARN/CRIT and reused as
    // impact-band.ts's global noise floor: keep the two in sync.
    thresholds: { minTasks: 10, shareWarn: 0.05, warnPct: 0.10, critPct: 0.20, floorPctWarn: STRAGGLER_FLOOR_PCT_WARN, floorPctCrit: STRAGGLER_FLOOR_PCT_CRIT },
    detect(
      this: {
        thresholds: { minTasks: number; shareWarn: number; warnPct: number; critPct: number; floorPctWarn: number; floorPctCrit: number };
      },
      stage: DetectorStage,
      ctx?: DetectorCtx,
    ): Finding | null {
      if (stage.taskCount < this.thresholds.minTasks) return null;
      const stragglerShare = (stage.stragglerCount ?? 0) / stage.taskCount;
      if ((stage.speculativeTasks ?? 0) === 0 && stragglerShare <= this.thresholds.shareWarn) return null;
      const useSpeculative = (stage.speculativeTasks ?? 0) > 0;
      const speculativeShare = useSpeculative ? stage.speculativeTasks / stage.taskCount : 0;
      // Same absolute delta impact-estimator.ts's straggler/stageShape case reports as savings: a
      // high straggler/speculative share on a stage whose tasks barely vary models near-zero
      // savings, so it must not outrank 'info'. Clipped the same way before the floor check.
      const wasteMs = Math.max(0, stage.taskDurationMax - stage.taskDurationP50);
      const appDurationMs = computeAppDurationMs(ctx);
      const floorWasteMs = clippedWasteMs(wasteMs, stage.id, ctx);
      const meetsWarnFloor = meetsRuntimeFloor(floorWasteMs, appDurationMs, this.thresholds.floorPctWarn);
      const meetsCritFloor = meetsRuntimeFloor(floorWasteMs, appDurationMs, this.thresholds.floorPctCrit);
      const speculativeTier = speculativeShare >= this.thresholds.critPct && meetsCritFloor ? 'critical'
                             : speculativeShare >= this.thresholds.warnPct && meetsWarnFloor ? 'warning' : 'info';
      // Straggler share has no dedicated critical tier per detector-contract.md; only warning.
      const stragglerTier = stragglerShare > this.thresholds.shareWarn && meetsWarnFloor ? 'warning' : 'info';
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
      return {
        type: 'straggler', stageId: stage.id, impactBand,
        metric: useSpeculativeMetric ? 'speculativeTasks' : 'stragglerShare',
        value,
        unit: useSpeculativeMetric ? 'count' : 'pct',
        speculativeTasks: stage.speculativeTasks ?? 0,
        stragglerCount: stage.stragglerCount ?? 0,
        confidence: useSpeculativeMetric
          ? stragglerConfidence(speculativeShare, this.thresholds.warnPct, this.thresholds.critPct)
          : stragglerConfidence(stragglerShare, this.thresholds.shareWarn, this.thresholds.critPct),
        validationRequired: 'This finding is gated by 0.5%/2% runtime-floor thresholds, our own noise floor for this metric.',
        recommendation: `${detail}: rule out a GC pause or a slow shuffle fetch before assuming a hardware issue; if a skewed key is the real cause, that's a candidate for AQE's skew-join handling.`,
      };
    },
  },
  {
    type: 'speculationWaste', scope: 'stage', order: 71, fixEffort: 'config', version: 1,
    docAnchor: '#bottleneck-straggler',
    thresholds: { minWasted: 5, minWasteMs: 60000 },
    detect(
      this: {
        thresholds: { minWasted: number; minWasteMs: number };
      },
      stage: DetectorStage,
    ): Finding | null {
      const wasted = stage.speculationWastedAttempts ?? 0;
      const wastedMs = stage.speculationWasteMs ?? 0;
      if (wasted < this.thresholds.minWasted || wastedMs < this.thresholds.minWasteMs) return null;
      return {
        type: 'speculationWaste', stageId: stage.id,
        impactBand: 'warning',
        metric: 'speculationWasteMs', value: wastedMs,
        confidence: speculationWasteConfidence(wastedMs, this.thresholds.minWasteMs),
        recommendation: `Speculative execution discarded ${Math.round(wastedMs / 1000)}s of executor time in this stage; if task durations are naturally variable rather than genuine stragglers, consider tuning spark.speculation.multiplier/quantile.`,
      };
    },
  },
  {
    type: 'retryWaste', scope: 'stage', order: 45, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-retry-waste',
    thresholds: { minWasted: 3, minWasteMs: 30000 },
    detect(
      this: { thresholds: { minWasted: number; minWasteMs: number } },
      stage: DetectorStage,
    ): Finding | null {
      const wasted = stage.wastedAttempts ?? 0;
      const wastedMs = stage.retryWasteMs ?? 0;
      if (wasted < this.thresholds.minWasted || wastedMs < this.thresholds.minWasteMs) return null;
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
  },
  {
    type: 'tinyTask', scope: 'stage', order: 80, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-tiny-tasks',
    thresholds: { minTasks: 100, maxP50: 500, maxP95: 1000 },
    detect(
      this: { thresholds: { minTasks: number; maxP50: number; maxP95: number } },
      stage: DetectorStage,
    ): Finding | null {
      if (stage.taskCount < this.thresholds.minTasks) return null;
      if (stage.taskDurationP50 > this.thresholds.maxP50 || stage.taskDurationP95 > this.thresholds.maxP95) return null;
      const coalesceTo = Math.max(1, Math.round(stage.taskCount / 10));
      const fix = stage.shuffleReadBytes > 0
        ? `lower spark.sql.shuffle.partitions or .coalesce(${coalesceTo})`
        : `.coalesce(${coalesceTo})`;
      return {
        type: 'tinyTask', stageId: stage.id, impactBand: 'info',
        metric: 'taskDurationP50', value: Math.round(stage.taskDurationP50),
        recommendation: `Many small tasks (${stage.taskCount}, P50 ${Math.round(stage.taskDurationP50)}ms): scheduler overhead may dominate. Try ${fix}.`,
      };
    },
  },
  {
    // No docAnchor: the upstream spark-tuning-reference docs have no section for this
    // tool-specific "capture stopped early" signal.
    type: 'incompleteRun', scope: 'app', order: 5, fixEffort: 'code', version: 1,
    thresholds: {},
    recommendation: 'This event log never recorded an ApplicationEnd event: the capture stopped before the run finished (an in-flight job, a rotated-away log, or a cut-short capture). Findings and metrics elsewhere on this board reflect only what was captured up to that point, not the full run.',
    detect(this: { recommendation: string }, ctx: DetectorCtx): Finding | null {
      if (!ctx.app || ctx.app.startTime == null || ctx.app.endTime != null) return null;
      return {
        type: 'incompleteRun', stageId: null, impactBand: 'warning',
        metric: 'applicationEnd', value: 'missing',
        recommendation: this.recommendation,
      };
    },
  },
  {
    type: 'coldStart', scope: 'app', order: 90, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-cold-start',
    thresholds: { gapSeconds: 30 },
    detect(
      this: { thresholds: { gapSeconds: number } },
      ctx: DetectorCtx,
    ): Finding | null {
      const { app, stages } = ctx;
      // Nullish (not falsy) check: a literal startTime:0 must not be treated as "missing".
      if (!app || app.startTime == null || stages.size === 0) return null;
      let firstTaskLaunch = Infinity;
      for (const stage of stages.values()) {
        if (stage.submittedAt > 0 && stage.submittedAt < firstTaskLaunch) firstTaskLaunch = stage.submittedAt;
      }
      // No stage ever recorded a submission timestamp: no basis to measure a startup gap against.
      // Exposed now that a literal app.startTime:0 no longer short-circuits this detector entirely.
      if (!Number.isFinite(firstTaskLaunch)) return null;
      const gapSeconds = (firstTaskLaunch - app.startTime) / 1000;
      if (gapSeconds <= this.thresholds.gapSeconds) return null;
      const value = Math.round(gapSeconds);
      return {
        type: 'coldStart', stageId: null, impactBand: 'warning',
        metric: 'startupGapSeconds', value,
        recommendation: `The first task waited ${value}s for executors to become available: keep a warm pool of idle executors, or if using dynamic allocation, raise the minimum/initial executor count so it doesn't scale up from zero.`,
      };
    },
  },
  {
    type: 'utilization', scope: 'app', order: 100, fixEffort: 'config', version: 1,
    docAnchor: '#bottleneck-utilization',
    thresholds: { minUtil: 0.60 },
    detect(
      this: { thresholds: { minUtil: number } },
      ctx: DetectorCtx,
    ): Finding | null {
      const { app, executorsAdded, executorsRemoved, runAggregates } = ctx;
      // Nullish (not falsy) check: a literal startTime:0 must not be treated as "missing".
      if (!app || executorsAdded.length === 0 || app.startTime == null || app.endTime == null) return null;
      const appDuration = app.endTime - app.startTime;
      if (appDuration <= 0) return null;
      // computePeakConcurrentCores (not executorsAdded.length/computeTotalCores): real concurrent
      // capacity, not a cumulative sum that double-counts a churned-through executor against its
      // replacement's (spot preemption, dynamicAllocation replacement).
      const totalCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);
      if (totalCores <= 0) return null;
      const capacityCoreMs = totalCores * appDuration;
      // Busy core-time (from the whole-run core-time-series, same signal memoryUtilization's
      // idleCores variant already uses), not executor lifetime: an executor that exists for the
      // whole run but sits fully idle must not score as 100% used. Missing runAggregates (older
      // callers, synthetic fixtures) reads as 0 busy time rather than falling back to the
      // lifetime-based measure this replaces.
      const busyCoreMs = runAggregates?.busyCoreMs ?? 0;
      const utilization = busyCoreMs / capacityCoreMs;
      if (utilization >= this.thresholds.minUtil) return null;

      // CPU-time-based utilization (sparkMeasure): metric only, no threshold.
      let cpuUtilizationPct: number | null = null;
      if (totalCores > 0) {
        let cpuMs = 0;
        // executorCpuTime is reported by Spark in nanoseconds.
        for (const s of ctx.stages.values()) cpuMs += nsToMs(s.executorCpuTime ?? 0);
        cpuUtilizationPct = Math.round((cpuMs / (appDuration * totalCores)) * 100);
      }

      const value = Math.round(utilization * 100);
      return {
        type: 'utilization', stageId: null, impactBand: 'info',
        metric: 'avgUtilization', value,
        utilizationFraction: utilization,
        appDurationMs: appDuration,
        totalCores,
        cpuUtilizationPct,
        recommendation: `Average executor utilization was only ${value}%: consider reducing cluster size or enabling dynamic allocation.`,
      };
    },
  },
  {
    type: 'memoryUtilization', scope: 'app', order: 102, fixEffort: 'config', version: 1,
    docAnchor: '#bottleneck-memory-utilization',
    thresholds: {
      idleCoreWarn: 0.50,          // WastedCoresAlertsReducer
      bandTooSmall: 0.95,          // MemoryAlertsReducer: used/allocated
      bandTooHigh: 0.70,           // below this => over-provisioned (cost signal)
      wasteBufferMultiplier: 1.5,  // UNVERIFIED
    },
    detect(
      this: {
        thresholds: {
          idleCoreWarn: number; bandTooSmall: number; bandTooHigh: number; wasteBufferMultiplier: number;
        };
      },
      ctx: DetectorCtx,
    ): Finding[] {
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
      const totalCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);
      // Hoisted above 1a (also 1b/1c's input) so the idle-cores finding carries the allocated
      // memory its MB-seconds estimate needs.
      const allocatedMB = app.resources?.executor?.memoryMB ?? null;

      // ── 1a idle-cores rate ────────────────────────────────────────────────
      if (runAggregates && totalCores > 0) {
        const capacityCoreMs = totalCores * appDurationMs;
        const idleRate = capacityCoreMs > 0 ? 1 - (runAggregates.busyCoreMs / capacityCoreMs) : 0;
        if (idleRate > this.thresholds.idleCoreWarn) {
          const value = Math.round(idleRate * 100);
          out.push({
            type: 'memoryUtilization', variant: 'idleCores', stageId: null,
            impactBand: 'warning', metric: 'idleCoreRate', value,
            // Raw (unrounded) rate plus sizing inputs for the impact estimator: `value` is rounded pct.
            idleRateFraction: idleRate, allocatedMB, peakExecutors, appDurationMs,
            recommendation: `${value}% of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.`,
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
        out.push({
          type: 'memoryUtilization', variant: 'memoryBand', stageId: null,
          impactBand: 'info', metric: 'memoryBand', dataUnavailable: true,
          recommendation: 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true: not enabled for this run.',
        });
      } else if (allocatedMB != null && allocatedMB > 0) {
        const allocatedBytes = allocatedMB * 1024 * 1024;
        for (const [execId, heap] of peakHeapByExec) {
          const ratio = heap / allocatedBytes;
          // The two bands are opposite signals: an explicit `rule` discriminator lets consumers
          // tell OOM-risk from over-provisioning without re-deriving the ratio.
          if (ratio > this.thresholds.bandTooSmall) {
            out.push({
              type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity',
              stageId: null, executorId: execId,
              impactBand: 'warning', metric: 'heapUsedRatio', value: Math.round(ratio * 100),
              recommendation: `Executor ${execId} peaked at ${Math.round(ratio * 100)}% of allocated heap: memory may be too small; raise spark.executor.memory to avoid OOM/spill.`,
            });
          } else if (ratio < this.thresholds.bandTooHigh) {
            out.push({
              type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned',
              stageId: null, executorId: execId,
              impactBand: 'info', metric: 'heapUsedRatio', value: Math.round(ratio * 100),
              // Absolute figures behind the rounded ratio, for the estimator's
              // unused-memory-over-time model.
              allocatedBytes, heap, appDurationMs,
              recommendation: `Executor ${execId} used only ${Math.round(ratio * 100)}% of allocated heap: memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.`,
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
        if (wastedMBSeconds > this.thresholds.wasteBufferMultiplier * usedMBSeconds) {
          const value = Math.round(wastedMBSeconds);
          out.push({
            type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
            impactBand: 'info', metric: 'wastedMBSeconds', value,
            confidence: memoryWasteConfidence(wastedMBSeconds, usedMBSeconds, this.thresholds.wasteBufferMultiplier),
            validationRequired: 'Memory-waste estimate uses allocated-vs-used memory-time and a 1.5x buffer: confirm against the Spark UI before acting.',
            recommendation: `Allocated executor memory sat largely idle over the run (~${value.toLocaleString('en-US')} MB-seconds wasted): review spark.executor.memory and executor count.`,
          });
        }
      }

      return out;
    },
  },
  {
    // Per-RDD cache-utilization proxies (this repo's own design: Spark event logs carry no
    // block-access events, so a literal cache hit rate isn't derivable). Two per-RDD tiered
    // checks over rddInfo snapshots: partial caching and disk spillover. An RDD can produce both.
    type: 'cacheUtilization', scope: 'app', order: 103, fixEffort: 'code', version: 1,
    docAnchor: '#memory-model',
    thresholds: {
      cachedRatioWarn: 0.50, cachedRatioInfo: 0.90,
      diskRatioWarn: 0.40, diskRatioInfo: 0.15,
    },
    detect(
      this: {
        thresholds: {
          cachedRatioWarn: number; cachedRatioInfo: number; diskRatioWarn: number; diskRatioInfo: number;
        };
      },
      ctx: DetectorCtx,
    ): Finding[] | null {
      const rddInfo = ctx.app?.rddInfo;
      if (!(rddInfo instanceof Map)) return null;
      const out: Finding[] = [];
      for (const rdd of rddInfo.values()) {
        const sl = rdd.storageLevel ?? {};
        if (!(sl.useMemory || sl.useDisk)) continue;
        if (!((rdd.numCachedPartitions ?? 0) > 0)) continue;

        if ((rdd.numPartitions ?? 0) > 0) {
          const cachedRatio = rdd.numCachedPartitions / rdd.numPartitions;
          if (cachedRatio < this.thresholds.cachedRatioWarn) out.push(partialCacheFinding(rdd, cachedRatio, 'warning'));
          else if (cachedRatio < this.thresholds.cachedRatioInfo) out.push(partialCacheFinding(rdd, cachedRatio, 'info'));
        }

        if (sl.useMemory && sl.useDisk) {
          const total = (rdd.memorySize ?? 0) + (rdd.diskSize ?? 0);
          if (total > 0) {
            const diskRatio = (rdd.diskSize ?? 0) / total;
            if (diskRatio > this.thresholds.diskRatioWarn) out.push(diskSpilloverFinding(rdd, diskRatio, 'warning'));
            else if (diskRatio > this.thresholds.diskRatioInfo) out.push(diskSpilloverFinding(rdd, diskRatio, 'info'));
          }
        }
      }
      return out;
    },
  },
  {
    // Non-local task ratio across stage.localityStats (RACK_LOCAL + ANY vs all tasks), the other
    // half of the "Wasted Cores Ratio" (idle-core half is memoryUtilization's idleCores).
    // NO_PREF stays in the denominator only: shuffle-read stages legitimately report it.
    type: 'coreLocality', scope: 'app', order: 103, fixEffort: 'config', version: 1,
    docAnchor: '#bottleneck-utilization',
    thresholds: { minTasks: 50, warnRatio: 0.15, critRatio: 0.35 },
    detect(
      this: { thresholds: { minTasks: number; warnRatio: number; critRatio: number } },
      ctx: DetectorCtx,
    ): Finding | null {
      const { totalTasks, nonLocalTasks, ratio } = computeCoreLocalityRatio([...ctx.stages.values()]);
      if (totalTasks == null || totalTasks < this.thresholds.minTasks) return null;
      // computeCoreLocalityRatio only returns ratio:null together with totalTasks:null (shared
      // EMPTY sentinel); the totalTasks guard above rules that out, so ratio is non-null here.
      if (ratio! < this.thresholds.warnRatio) return null;

      const value = Math.round(ratio! * 100);
      return {
        type: 'coreLocality', stageId: null,
        impactBand: ratio! >= this.thresholds.critRatio ? 'critical' : 'warning',
        metric: 'nonLocalRatio', value,
        // Raw count behind the ratio, for the impact estimator. Non-null whenever totalTasks is.
        nonLocalTaskCount: nonLocalTasks!,
        confidence: coreLocalityConfidence(ratio!, totalTasks, this.thresholds),
        validationRequired: 'This finding is gated by 15%/35% non-local-ratio thresholds (and a 50-task minimum), our own noise floor for this metric.',
        recommendation: `${value}% of tasks (${nonLocalTasks!}) ran without process- or node-local data placement: check spark.locality.wait settings and executor/data colocation.`,
      };
    },
  },
  {
    // Short-lived executors: stood up and torn down before doing useful work (wasteful
    // re-provisioning, not normal scale-down). Reuses utilization's add/remove matching, but
    // measures lifetime against a threshold instead of aggregate active-time.
    type: 'autoscalingChurn', scope: 'app', order: 103, fixEffort: 'config', version: 1,
    thresholds: { shortLivedMs: 120_000, warningPct: 0.30, criticalPct: 0.60, minExecutors: 5 },
    detect(
      this: {
        thresholds: { shortLivedMs: number; warningPct: number; criticalPct: number; minExecutors: number };
      },
      ctx: DetectorCtx,
    ): Finding | null {
      const { app, executorsAdded, executorsRemoved } = ctx;
      if (!app || executorsAdded.length === 0 || app.endTime == null) return null;
      if (executorsAdded.length < this.thresholds.minExecutors) return null;

      const removedAt = new Map<string, number>();
      for (const ev of executorsRemoved) removedAt.set(ev.executorId, ev.timestamp);

      let shortLivedCount = 0;
      for (const ev of executorsAdded) {
        const endedAt = removedAt.has(ev.executorId) ? removedAt.get(ev.executorId)! : app.endTime;
        const lifetime = endedAt - ev.timestamp;
        if (lifetime < this.thresholds.shortLivedMs) shortLivedCount++;
      }

      const shortLivedPct = shortLivedCount / executorsAdded.length;
      const impactBand = shortLivedPct > this.thresholds.criticalPct ? 'critical'
                        : shortLivedPct > this.thresholds.warningPct ? 'warning' : null;
      if (!impactBand) return null;

      const pct = Math.round(shortLivedPct * 100);
      return {
        type: 'autoscalingChurn', stageId: null, impactBand,
        metric: 'shortLivedExecutorPct', value: pct,
        // Raw count behind the percentage, for the impact estimator's startup-overhead figure.
        shortLivedExecutorCount: shortLivedCount,
        confidence: autoscalingChurnConfidence(shortLivedPct, this.thresholds.warningPct, this.thresholds.criticalPct),
        recommendation: `${pct}% of executors ran for under 2 minutes before being removed. This looks like wasteful re-provisioning rather than normal scale-down; consider raising spark.dynamicAllocation.executorIdleTimeout or widening the minExecutors/maxExecutors bounds to reduce flapping.`,
      };
    },
  },
  {
    // Cross-execution relation reuse: flags an input relation scanned by two or more SQL
    // executions in one run, firing on real relation names (parquet:..., jdbc:...).
    type: 'cachingOpportunity', scope: 'app', order: 105, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-utilization',
    thresholds: { minExecutions: 2 },
    detect(this: { thresholds: { minExecutions: number } }, ctx: DetectorCtx): Finding[] | null {
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
          const rid = scanRelationId(node.name ?? '', node.detail ?? '');
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
        byComposite.has(fp) && byComposite.get(fp)!.executionIds.size >= this.thresholds.minExecutions;
      const compositeResolutions = new Map<string, CompositeResolution>();
      for (const [fingerprint, agg] of byComposite) {
        if (!isQualifying(fingerprint)) { compositeResolutions.set(fingerprint, { finalExecutionIds: agg.executionIds, suppressed: true }); continue; }
        const qualifyingAncestors = [...agg.ancestorFingerprints].filter(isQualifying).map(fp => byComposite.get(fp)!);
        if (qualifyingAncestors.length === 0) { compositeResolutions.set(fingerprint, { finalExecutionIds: agg.executionIds, suppressed: false }); continue; }
        const coveredByAncestors = new Set(qualifyingAncestors.flatMap(outer => [...outer.executionIds]));
        const residual = new Set([...agg.executionIds].filter(id => !coveredByAncestors.has(id)));
        if (residual.size === 0) compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: true });
        else if (residual.size < this.thresholds.minExecutions) compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: true });
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
          ? `${verb[0].toUpperCase()}${verb.slice(1)} result read by ${value} queries (~${formatBytes(totalReadBytes)}). Cache/persist the ${verb} DataFrame so it is computed once.`
          : `${verb[0].toUpperCase()}${verb.slice(1)} result read by ${value} queries. Cache the ${verb} DataFrame, or reconsider whether it needs to be recomputed each time.`;

        out.push({
          type: 'cachingOpportunity', variant: 'composite', stageId: null, impactBand: 'info',
          metric: 'executionReuse', value,
          format: 'derived', relations, operator: agg.operator, relation: relationDisplay,
          executionIds: finalExecutionIds, totalReadBytes,
          confidence: cachingReuseConfidence(value, this.thresholds.minExecutions),
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
        if (residualExecutionIds.length < this.thresholds.minExecutions) continue;
        const value = residualExecutionIds.length;
        const totalReadBytes = residualExecutionIds.reduce((sum, id) => sum + (agg.executionBytes.get(id) ?? 0), 0);
        const recommendation = totalReadBytes >= 128 * MB
          ? `Read by ${value} queries (~${formatBytes(totalReadBytes)}). Cache/persist the shared DataFrame so it is scanned once.`
          : `Read by ${value} queries. Cache the shared DataFrame, or broadcast it if it is a small join lookup.`;
        out.push({
          type: 'cachingOpportunity', stageId: null, impactBand: 'info',
          metric: 'executionReuse', value,
          relation: agg.relation, format: agg.format,
          executionIds: residualExecutionIds.sort((a, b) => a - b),
          totalReadBytes,
          confidence: cachingReuseConfidence(value, this.thresholds.minExecutions),
          validationRequired:
            'Relation-reuse is inferred from the pre-AQE plan scan identity across SQL ' +
            'executions; confirm the reads are the same data and cacheable within one ' +
            'session before acting.',
          recommendation,
        });
      }
      return out;
    },
  },
  {
    type: 'jobFailureRate', scope: 'app', order: 110, fixEffort: 'code', version: 1,
    docAnchor: '#bottleneck-job-failure-rate',
    thresholds: { infoRate: 0.10, warnRate: 0.30, critRate: 0.50 },
    detect(
      this: { thresholds: { infoRate: number; warnRate: number; critRate: number } },
      ctx: DetectorCtx,
    ): Finding | null {
      const { jobs, stages } = ctx;
      const all = jobs ? [...jobs.values()] : [];
      const completed = all.filter(j => j.result != null);
      if (completed.length === 0) return null;
      const failedJobList = completed.filter(j => j.succeeded === false);
      const failedJobs = failedJobList.length;
      const rate = failedJobs / completed.length;
      if (rate < this.thresholds.infoRate) return null;
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
        impactBand: rate >= this.thresholds.critRate ? 'critical' : rate >= this.thresholds.warnRate ? 'warning' : 'info',
        metric: 'jobFailureRate', value: Math.round(rate * 1000) / 10,
        failedJobs, totalJobs, failedTasks, totalTasks, avgJobDurationMs,
        taskFailureRate: Math.round(taskFailureRate * 1000) / 10,
        recommendation: `${failedJobs} of ${totalJobs} jobs never recovered: inspect the driver log for the failed job(s) and the stage failures that triggered them.`,
      };
    },
  },
  // ── Config-sanity entries (scope:'config', inScorecard:false) ────────────────
  {
    type: 'configAudit', scope: 'config', order: 120, fixEffort: 'config', version: 1, inScorecard: false,
    docAnchor: '#config-shuffle-service', thresholds: {}, property: 'spark.shuffle.service.enabled',
    detect(ctx: DetectorConfigTarget): Finding | null {
      const res = ctx.app?.resources ?? null;
      if (res?.dynamicAllocationEnabled === true && res?.shuffleServiceEnabled === false) {
        return {
          type: 'configAudit', property: 'spark.shuffle.service.enabled',
          impactBand: 'warning', metric: 'config', value: 'false',
          recommendation: 'Dynamic allocation is on but the external shuffle service is off: set spark.shuffle.service.enabled=true so shuffle data survives executor removal.',
        };
      }
      return null;
    },
  },
  {
    type: 'configAudit', scope: 'config', order: 121, fixEffort: 'config', version: 1, inScorecard: false,
    docAnchor: '#config-autoscale-bounds', thresholds: {}, property: 'spark.dynamicAllocation.maxExecutors',
    detect(ctx: DetectorConfigTarget): Finding | null {
      const app = ctx.app; const config = app?.config ?? {}; const res = app?.resources ?? null;
      if (res?.dynamicAllocationEnabled !== true) return null;
      const minN = config['spark.dynamicAllocation.minExecutors'] != null ? parseInt(config['spark.dynamicAllocation.minExecutors'], 10) : null;
      const maxN = config['spark.dynamicAllocation.maxExecutors'] != null ? parseInt(config['spark.dynamicAllocation.maxExecutors'], 10) : null;
      if (minN != null && maxN != null && minN > maxN) {
        return {
          type: 'configAudit', property: 'spark.dynamicAllocation.minExecutors',
          impactBand: 'critical', metric: 'config', value: `${minN} > ${maxN}`,
          recommendation: `Autoscaling bounds are inverted: spark.dynamicAllocation.minExecutors (${minN}) exceeds maxExecutors (${maxN}). Set min ≤ max.`,
        };
      }
      if (maxN == null) {
        return {
          type: 'configAudit', property: 'spark.dynamicAllocation.maxExecutors',
          impactBand: 'info', metric: 'config', value: '(unset)',
          recommendation: 'Dynamic allocation is on with no upper bound: set spark.dynamicAllocation.maxExecutors to cap cluster growth.',
        };
      }
      return null;
    },
  },
  {
    type: 'configAudit', scope: 'config', order: 122, fixEffort: 'config', version: 1, inScorecard: false,
    docAnchor: '#config-serializer', thresholds: {}, property: 'spark.serializer',
    detect(ctx: DetectorConfigTarget): Finding | null {
      const app = ctx.app; const config = app?.config ?? {}; const res = app?.resources ?? null;
      if (Object.keys(config).length === 0) return null;
      const ser = res?.serializer ?? config['spark.serializer'] ?? null;
      const isKryo = typeof ser === 'string' && /kryo/i.test(ser);
      if (isKryo) return null;
      return {
        type: 'configAudit', property: 'spark.serializer',
        impactBand: 'info', metric: 'config', value: ser ?? '(default JavaSerializer)',
        recommendation: `Current serializer is ${ser ?? 'the default JavaSerializer'}: consider spark.serializer=org.apache.spark.serializer.KryoSerializer for faster, smaller buffers.`,
      };
    },
  },
  {
    type: 'configAudit', scope: 'config', order: 123, fixEffort: 'config', version: 1, inScorecard: false,
    docAnchor: '#config-memory-overhead', thresholds: { floorMB: 384, floorPct: 0.1 }, property: 'spark.executor.memoryOverhead',
    detect(
      this: { thresholds: { floorMB: number; floorPct: number } },
      ctx: DetectorConfigTarget,
    ): Finding | null {
      const res = ctx.app?.resources ?? null;
      const memMB = res?.executor?.memoryMB ?? null;
      const ovMB = res?.executor?.memoryOverheadMB ?? null;
      if (memMB == null || ovMB == null) return null;
      const floor = Math.max(this.thresholds.floorMB, Math.round(memMB * this.thresholds.floorPct));
      if (ovMB >= floor) return null;
      return {
        type: 'configAudit', property: 'spark.executor.memoryOverhead',
        impactBand: 'info', metric: 'config', value: `${ovMB} MiB`,
        recommendation: `Executor memoryOverhead (${ovMB} MiB) is below Spark's default floor of ${floor} MiB (max of 384 MiB or 10% of executor memory): raise it to avoid off-heap OOM-kills.`,
      };
    },
  },
  // ── Plan-metric entries (scope:'sql') ────────────────────────────────────
  {
    type: 'duplicatePlanSubtree', scope: 'sql', order: 130, fixEffort: 'code', version: 2,
    docAnchor: '#bottleneck-duplicate-plan-subtree',
    thresholds: { minSubtreeSize: 3, minOccurrences: 2 },
    detect(
      this: { thresholds: { minSubtreeSize: number; minOccurrences: number } },
      sqlExec: DetectorSqlExec,
      ctx: DetectorCtx,
    ): Finding[] | null {
      if (!sqlExec.planTree) return null;
      const groups = findDuplicateSubtrees(sqlExec.planTree, this.thresholds);
      if (groups.length === 0) return null;
      const fallbackStageIds = stageIdsForSqlExec(sqlExec.id, ctx.stages);
      return groups.map((g) => {
        const nodes: PlanNode[] = [];
        for (const n of g.nodes) walkPlanTree(n, (node) => nodes.push(node));
        const stageIds = unionStageIds(nodes, fallbackStageIds);
        // resolvePlanTree always sets id; safe downstream of it.
        const planNodeIds = nodes.map((n) => n.id!).filter(Boolean);
        const touching = g.sampleRelation ? ` (touching ${g.sampleRelation})` : '';
        return {
          type: 'duplicatePlanSubtree', executionId: sqlExec.id, stageIds, planNodeIds,
          // Fixed fallback: overwritten by deriveImpactBand when this finding gets a real
          // wallClock estimate (the common case). Only surfaces on the rare occupancy-sweep miss.
          impactBand: 'warning', metric: 'subtreeOccurrences', value: g.occurrences,
          rootName: g.rootName, subtreeSize: g.subtreeSize, sampleRelation: g.sampleRelation,
          groupIndex: g.groupIndex,
          confidence: duplicateSubtreeConfidence(g.subtreeSize, g.occurrences, this.thresholds),
          validationRequired: 'Duplicate-subtree matching compares operator names and metric names only, not literal values or expr IDs: confirm the repeated work is real in the Spark SQL plan tab before acting.',
          recommendation: g.isExchangeRoot
            ? `A ${g.subtreeSize}-node subtree rooted at ${pathBasename(g.rootName)} repeats ${g.occurrences}x in this plan${touching}: this looks like a possible missed exchange reuse; check whether the same shuffle could be computed once and reused.`
            : `A ${g.subtreeSize}-node subtree rooted at ${pathBasename(g.rootName)} repeats ${g.occurrences}x in this plan${touching}: consider caching/persisting the shared computation or check for a duplicated query branch.`,
        };
      });
    },
  },
  {
    type: 'smallFiles', scope: 'sql', order: 131, fixEffort: 'config', version: 2,
    docAnchor: '#bottleneck-small-files',
    thresholds: { minFiles: 100, maxAvgFileSizeMB: 3 },
    detect(
      this: { thresholds: { minFiles: number; maxAvgFileSizeMB: number } },
      sqlExec: DetectorSqlExec,
      ctx: DetectorCtx,
    ): Finding[] | null {
      if (!sqlExec.planTree) return null;
      const { minFiles, maxAvgFileSizeMB } = this.thresholds;
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
  },
  {
    // Entry-level type is an identifier only; it never appears on an emitted finding. Findings
    // carry 'underBroadcast'/'overBroadcast' since one shared plan-walk covers both
    // opposite-direction rules (JoinToBroadcastAlert / BroadcastTooLargeAlert).
    type: 'broadcastSizing', scope: 'sql', order: 132, fixEffort: 'config', version: 2,
    docAnchor: '#bottleneck-broadcast-sizing',
    thresholds: {
      broadcastTiers: [10 * MB, 100 * MB, GB, 5 * GB],
      comparisonTiers: [10 * GB, 300 * GB, TB],
      overBroadcastBytes: GB,
    },
    detect(
      this: {
        thresholds: { broadcastTiers: number[]; comparisonTiers: number[]; overBroadcastBytes: number };
      },
      sqlExec: DetectorSqlExec,
      ctx: DetectorCtx,
    ): Finding[] | null {
      if (!sqlExec.planTree) return null;
      const { broadcastTiers, comparisonTiers, overBroadcastBytes } = this.thresholds;
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
              out.push({
                type: 'underBroadcast', executionId: sqlExec.id, stageIds: unionStageIds(contributors, fallbackStageIds),
                // resolvePlanTree always sets id; safe downstream of it.
                planNodeIds: contributors.map((n) => n.id!).filter(Boolean),
                impactBand: 'info', metric: 'smallerSideBytes', value: smaller,
                largerSideBytes: larger,
                recommendation: `The smaller input to this Sort Merge Join (${formatBytes(smaller)}) is well under the broadcast threshold relative to the larger side (${formatBytes(larger)}): this could have been a broadcast join. Consider a broadcast() hint or raising spark.sql.autoBroadcastJoinThreshold.`,
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
            out.push({
              type: 'overBroadcast', executionId: sqlExec.id,
              stageIds: unionStageIds(child ? [child] : [], fallbackStageIds),
              // resolvePlanTree always sets id; safe downstream of it.
              planNodeIds: [node.id!].filter(Boolean),
              impactBand: 'warning', metric: 'broadcastBytes', value: m.value,
              recommendation: `This broadcast (${formatBytes(m.value)}) exceeds the 1 GB threshold: check for a misapplied broadcast hint or a misconfigured spark.sql.autoBroadcastJoinThreshold.`,
            });
          }
        }
      });
      return out.length ? out : null;
    },
  },
];
