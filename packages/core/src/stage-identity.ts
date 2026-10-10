import { cyrb53 } from './string-hash.ts';
import { planNodesOfStage } from './stage-plan-nodes.ts';
import type { Stage, PlanNode } from './types.ts';
import type { SessionSnapshot } from './session-snapshot.ts';

// The stage-identity recipe, parameterized by the detail normalizer. `stageIdentity` (the frozen
// exact key, run-comparison.ts) runs it with `normalizeDetail`; the aligner's `comparisonIdentity`
// runs it with the comparison normalizer. One recipe, so the two keys can differ only in how a
// detail string is normalized.

export type DetailNormalizer = (detail: string) => string;

// Replace run-varying tokens (digit runs, long hex ids) with a stable marker so
// the same logical stage across two runs normalizes to one identity.
export function normalizeStageName(name: string): string {
  if (name.length > STAGE_NAME_CACHE_MAX_LENGTH) return computeStageName(name);
  let normalized = stageNameCache.get(name);
  if (normalized === undefined) {
    if (stageNameCache.size >= STAGE_NAME_CACHE_MAX_ENTRIES) stageNameCache.clear();
    normalized = computeStageName(name);
    stageNameCache.set(name, normalized);
  }
  return normalized;
}

// A comparison normalizes the same few operator and stage names once per stage, identity and key.
// Only short names are kept (long inputs are call-site text, rarely repeated), and the whole table
// resets when full, so it stays small however many runs a long-lived process analyzes.
const STAGE_NAME_CACHE_MAX_LENGTH = 256;
const STAGE_NAME_CACHE_MAX_ENTRIES = 4096;
const stageNameCache = new Map<string, string>();

function computeStageName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, '#') // hex ids/uuids first (they contain digits)
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

// A plan node belongs to every stage that ran part of it, and each of those stages reads its
// normalized detail again (exact key, structural key, similarity tokens), on both runs of a
// comparison. The normalizer is a pure function of the detail and a node is never mutated after the
// parser posts it, so the result is memoized per node. Like the per-tree identity below, each node
// keeps at most MAX_NORMALIZERS_PER_TREE normalizers and drops the oldest first.
const nodeDetailCache = new WeakMap<PlanNode, Map<DetailNormalizer, string>>();

export function normalizedDetailOf(node: PlanNode, normalizeDetail: DetailNormalizer): string {
  let byNormalizer = nodeDetailCache.get(node);
  if (!byNormalizer) {
    byNormalizer = new Map();
    nodeDetailCache.set(node, byNormalizer);
  }
  let normalized = byNormalizer.get(normalizeDetail);
  if (normalized === undefined) {
    normalized = normalizeDetail(node.detail ?? '');
    if (byNormalizer.size >= MAX_NORMALIZERS_PER_TREE) byNormalizer.delete(byNormalizer.keys().next().value!);
    byNormalizer.set(normalizeDetail, normalized);
  }
  return normalized;
}

// Bottom-up, order-independent structural identity of a resolved plan tree:
// each node folds its normalized name/detail with its children's digests
// (children sorted, so AQE picking a different broadcast side still matches),
// so two plans collide only when their whole shape and every node's detail
// agree. `normalizeDetail` strips the run-to-run noise (expr ids, `plan_id=`,
// codegen numbers, AQE build-side choice, commutative-operand order). Each
// node folds to a fixed-length cyrb53 digest (JSON.stringify-encoded, so
// detail text containing `<`/`>`/`{`/`,` can't collide two different plans)
// instead of embedding full child identity strings, which would re-escape
// every level below and blow identity size up to ~2^depth on the 20-60+
// operator-deep plans real Spark produces.
//
// Memoized per resolved tree (a tree is never mutated after the parser posts it), because every
// stage of an execution that has no attributed node falls back to the same whole-tree identity.
// The aligner builds a fresh normalizer closure per call, so each tree keeps at most
// MAX_NORMALIZERS_PER_TREE entries and drops the oldest first.
const MAX_NORMALIZERS_PER_TREE = 4;
const planTreeIdentityCache = new WeakMap<PlanNode, Map<DetailNormalizer, string>>();

function planTreeIdentity(root: PlanNode | null | undefined, normalizeDetail: DetailNormalizer): string | null {
  if (!root) return null;
  const byNormalizer = planTreeIdentityCache.get(root) ?? new Map<DetailNormalizer, string>();
  const cached = byNormalizer.get(normalizeDetail);
  if (cached !== undefined) return cached;
  function visit(node: PlanNode): string {
    const childDigests = (node.children ?? []).map(visit).sort();
    return cyrb53(JSON.stringify([normalizeStageName(node.name ?? ''), normalizedDetailOf(node, normalizeDetail), childDigests]));
  }
  const identity = visit(root);
  if (byNormalizer.size >= MAX_NORMALIZERS_PER_TREE) byNormalizer.delete(byNormalizer.keys().next().value!);
  byNormalizer.set(normalizeDetail, identity);
  planTreeIdentityCache.set(root, byNormalizer);
  return identity;
}

// Plan identity for the stage's SQL execution, scoped to only the plan nodes
// this stage actually ran (`node.stageIds`), not the whole tree: two stages
// sharing one SQL execution (e.g. a self-join's two Exchange stages) otherwise
// collapse onto one identity regardless of which part of the plan each ran.
// Falls back to the coarser whole-tree identity when the stage has no
// attributed nodes (hand-built snapshots without `stageIds`, or unmatched
// accumulables).
function sqlNodeIdentity(
  stage: Stage, snapshot: Pick<SessionSnapshot, 'sql'>, normalizeDetail: DetailNormalizer, nodes?: PlanNode[],
): string {
  const execId = stage.sqlExecutionId;
  if (execId == null) return '';
  const root = snapshot.sql.get(execId)?.planTree ?? null;
  if (!root) return '';
  const fingerprints = (nodes ?? planNodesOfStage(stage, snapshot.sql))
    .map((node) => JSON.stringify([normalizeStageName(node.name ?? ''), normalizedDetailOf(node, normalizeDetail)]));
  if (fingerprints.length === 0) return planTreeIdentity(root, normalizeDetail) ?? '';
  return cyrb53(JSON.stringify(fingerprints.sort()));
}

/** `nodes`: the stage's attributed plan nodes when the caller already has them (`planNodesOfStage`),
 * so one walk of the plan serves several readers. */
export function stageIdentityWith(
  stage: Stage, snapshot: Pick<SessionSnapshot, 'sql'>, normalizeDetail: DetailNormalizer, nodes?: PlanNode[],
): string {
  return normalizeStageName(stage.name ?? '') + '§' + sqlNodeIdentity(stage, snapshot, normalizeDetail, nodes);
}

export function identityIndexWith(
  snapshot: SessionSnapshot, identityOf: (stage: Stage, id: number) => string, only: (id: number) => boolean = () => true,
): Map<string, number[]> {
  const byIdentity = new Map<string, number[]>();
  for (const [id, stage] of snapshot.stages) {
    if (!only(id)) continue;
    const key = identityOf(stage, id);
    const ids = byIdentity.get(key);
    if (ids) ids.push(id);
    else byIdentity.set(key, [id]);
  }
  return byIdentity;
}

/** Pairs the stages of two identity indexes. An identity colliding equally on both sides has no
 * genuine ambiguity about *count*, so its stages pair off positionally by sorted id rather than
 * being dropped. This is exact when the identity actually distinguishes stages (e.g.
 * self-comparing a run: every stage matches itself). It's a best-effort guess when the identity is
 * coarse (no SQL/attribution) and the two sides are genuinely different runs -- two unrelated
 * same-named stages could get cross-paired. Accepted tradeoff: dropping them instead would also
 * sacrifice the exact-self-comparison case, which matters more. An identity with different counts
 * per side pairs nothing. Deterministic and symmetric: identities visit in sorted order. */
export function pairEqualCounts(
  baseIdx: Map<string, number[]>, candIdx: Map<string, number[]>,
): { pairs: Array<{ identity: string; baseId: number; candId: number }>; matchedIdentities: Set<string> } {
  const pairs: Array<{ identity: string; baseId: number; candId: number }> = [];
  const matchedIdentities = new Set<string>();
  for (const identity of [...baseIdx.keys()].sort()) {
    const candIds = candIdx.get(identity);
    if (!candIds) continue;
    const baseIds = baseIdx.get(identity)!;
    if (baseIds.length !== candIds.length) continue;
    const sortedBaseIds = [...baseIds].sort((a, b) => a - b);
    const sortedCandIds = [...candIds].sort((a, b) => a - b);
    for (let i = 0; i < sortedBaseIds.length; i++) {
      pairs.push({ identity, baseId: sortedBaseIds[i], candId: sortedCandIds[i] });
    }
    matchedIdentities.add(identity);
  }
  return { pairs, matchedIdentities };
}
