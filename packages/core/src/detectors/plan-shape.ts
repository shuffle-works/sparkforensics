import { scanRelationId } from '../plan-summary.ts';
import { walkPlanTree } from '../plan-tree-walk.ts';
import { isExchangeNode } from '../plan-node-detail.ts';
import { cyrb53 } from '../string-hash.ts';
import type { PlanNode } from '../types.ts';

// Bottom-up shape computation for duplicate-subtree detection and the
// cachingOpportunity composite detector. `size` is the subtree node count; the default
// fingerprint encodes operator name + sorted metric NAMES (never values) + a digest
// of each child's fingerprint, so two subtrees with the same shape but different values still
// collide. Digesting children keeps each fingerprint O(own size): embedding the full child
// strings made every node carry its whole subtree, O(n x depth) text on deep real plans.
//
// opts.includeDetail (default false) folds root's own detail (via opts.normalizeDetail) into
// ONLY root's fingerprint, never a child's: lets a caller match "this node's own detail + shape"
// without descendant scan detail entering the comparison.
interface PlanShape { size: number; fingerprint: string; }

// The metric names a node's fingerprint is built from. Executor-side values are left out: whether
// one resolves depends on which tasks reported it, and a fingerprint (and the duplicatePlanSubtree
// and cachingOpportunity ids derived from it) must not shift when a run reports more of them.
function fingerprintMetricNames(metrics: PlanNode['metrics']): string {
  return (metrics ?? []).filter((m) => !m.executorSide).map((m) => m.name).sort().join(',');
}

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
    const metricNames = fingerprintMetricNames(realMetrics);
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
  // every one of its letters (O(length^2) on long join details).
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
export function relationIdOf(node: PlanNode): string | null {
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

    const metricNames = fingerprintMetricNames(node.metrics);
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
  // Guard only: computePlanShapes steps through a read node to its write half's children, so no
  // write-half node reaches allNodes.
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

// Exact metric names Spark emits, verified against a real SQLExecutionStart's sparkPlanInfo.
// The write-side byte metric is "written output", not "size of written files".
export const FILES_READ_COUNT = 'number of files read';
export const FILES_READ_BYTES = 'size of files read';
export const FILES_WRITTEN_COUNT = 'number of written files';
export const FILES_WRITTEN_BYTES = 'written output';
