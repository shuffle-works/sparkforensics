// Canonical iterative walk over a resolved planTree (parser-worker.js
// resolvePlanTree). Every plan-*.js consumer and the sql-scope detectors in
// detectors.js need the same traversal: this is the single implementation
// they all share, so it must not import from detectors.js (or vice versa).
//
// Pre-order, left-to-right child order (children are reverse-pushed so the
// leftmost pops first): plan-summary.js's finding order depends on this.
// `visit(node, parent)` gets the parent so callers needing per-edge or
// per-node state (plan-dot.js's edges, plan-duration-attribution.js's segment
// index) can track it themselves via a Map keyed by node.
export function walkPlanTree<T extends { children?: T[] }>(
  root: T | null | undefined,
  visit: (node: T, parent: T | null) => void,
  { dedupe = false }: { dedupe?: boolean } = {},
): void {
  if (!root) return;
  const seen = dedupe ? new Set<T>() : null;
  const stack: { node: T; parent: T | null }[] = [{ node: root, parent: null }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    if (seen) {
      if (seen.has(node)) continue;
      seen.add(node);
    }
    visit(node, parent);
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], parent: node });
  }
}
