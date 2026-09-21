// Graphviz DOT export of a resolved planTree. No metric annotation.
import type { PlanNode } from './types.ts';
import { walkPlanTree } from './plan-tree-walk.ts';

function esc(s: string): string { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

export function planTreeToDot(planTree: PlanNode | null, { title = 'plan' }: { title?: string } = {}): string {
  if (!planTree) return '';
  const lines = [`digraph "${esc(title)}" {`, '  rankdir=BT;', '  node [shape=box];'];
  const idOf = new WeakMap<PlanNode, string>();
  const edges: string[] = [];
  let counter = 0;
  walkPlanTree(planTree, (node, parent) => {
    const id = `n${counter++}`;
    idOf.set(node, id);
    const label = node.detail && node.detail !== node.name ? `${node.name}\\n${node.detail}` : node.name;
    lines.push(`  ${id} [label="${esc(label)}"];`);
    // Pre-order: parent's id is assigned before any child, so one walk covers labels and edges.
    if (parent) edges.push(`  ${idOf.get(parent)} -> ${id};`);
  }, { dedupe: true });
  return [...lines, ...edges, '}'].join('\n');
}
