// What the stage aligner compares beyond the exact comparison key: a stage's structural key (operator
// tree shape, node names and sorted attribute names, with literals, paths, file counts and ids
// removed) and the token sets its similarity scores read. Pure.

import { cyrb53 } from './string-hash.ts';
import { normalizeStageName, normalizedDetailOf, type DetailNormalizer } from './stage-identity.ts';
import type { PlanNode } from './types.ts';

// Plumbing nodes: codegen boundaries and input adapters change with how Spark fuses a stage, not with
// the query, so the structural key and the similarity tokens skip them.
const PLUMBING_NODE = /^(WholeStageCodegen|InputAdapter|ColumnarToRow|RowToColumnar)\b/;

const isPlumbing = (node: PlanNode): boolean => PLUMBING_NODE.test(node.name ?? '');

/** The attribute names a plan node's text mentions (`amount#12` gives `amount`), without ids, each
 * once, sorted. Sorting makes the key insensitive to the nondeterministic order in which Spark lists
 * grouping and projection columns; reading only `name#id` references leaves literals out. */
export function attributeNames(detail: string): string[] {
  const names = new Set<string>();
  for (const m of detail.matchAll(/([A-Za-z_][\w$.]*)#\d+L?/g)) names.add(m[1]);
  return [...names].sort();
}

/** The structural key of a stage from the plan nodes attributed to it, or null when nothing but
 * plumbing is attributed. The nodes form a forest (a node's parent is its nearest attributed
 * ancestor); the key folds each node's normalized name, its sorted attribute names and its
 * children's digests (sorted, so a join's side order does not matter). Only structure goes in: no
 * node detail, so a literal, a path or a file count never splits two stages. */
export function structuralKey(nodes: readonly PlanNode[]): string | null {
  const attributed = new Set(nodes.filter((n) => !isPlumbing(n)));
  if (attributed.size === 0) return null;
  const digests = new Map<PlanNode, string>();
  const nested = new Set<PlanNode>();
  // Digests of the nearest attributed descendants of `node`'s children.
  const below = (node: PlanNode): string[] => {
    const out: string[] = [];
    for (const child of node.children ?? []) {
      if (attributed.has(child)) { out.push(digestOf(child)); nested.add(child); }
      else out.push(...below(child));
    }
    return out;
  };
  const digestOf = (node: PlanNode): string => {
    let d = digests.get(node);
    if (d === undefined) {
      d = cyrb53(JSON.stringify([normalizeStageName(node.name ?? ''), attributeNamesOf(node), below(node).sort()]));
      digests.set(node, d);
    }
    return d;
  };
  for (const node of attributed) digestOf(node);
  const roots = [...attributed].filter((n) => !nested.has(n)).map(digestOf).sort();
  return cyrb53(JSON.stringify(roots));
}

// A node's attribute names are read by the structural key of every stage it ran in and by the
// execution's plan structure; a node is never mutated after the parser posts it.
const attributeNamesCache = new WeakMap<PlanNode, string[]>();

/** `attributeNames` of a plan node's detail, memoized per node. The array is shared: do not change it. */
export function attributeNamesOf(node: PlanNode): readonly string[] {
  let names = attributeNamesCache.get(node);
  if (names === undefined) {
    names = attributeNames(node.detail ?? '');
    attributeNamesCache.set(node, names);
  }
  return names;
}

const TOKEN_SPLIT = /[^A-Za-z0-9_.$]+/;

/** Sorted distinct tokens of a stage's attributed nodes (name and normalized detail) and its name.
 * Two stages whose text differs in one literal share nearly every token. */
export function detailTokens(stageName: string | undefined, nodes: readonly PlanNode[], normalize: DetailNormalizer): string[] {
  const tokens = new Set<string>();
  const add = (text: string) => { for (const t of text.split(TOKEN_SPLIT)) if (t) tokens.add(t); };
  add(normalizeStageName(stageName ?? ''));
  for (const node of nodes) {
    if (isPlumbing(node)) continue;
    add(normalizeStageName(node.name ?? ''));
    add(normalizedDetailOf(node, normalize));
  }
  return [...tokens].sort();
}

/** Jaccard similarity of two sorted arrays; 1 when both are empty. An element repeated in both counts
 * as often as it repeats in the shorter side (multiset Jaccard), so distinct arrays give the plain one. */
export function jaccard(a: ArrayLike<string | number>, b: ArrayLike<string | number>): number {
  if (a.length === 0 && b.length === 0) return 1;
  let i = 0, j = 0, both = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { both++; i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return both / (a.length + b.length - both);
}
