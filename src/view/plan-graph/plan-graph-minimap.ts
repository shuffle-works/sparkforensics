import type { Node } from '@xyflow/react';
import type { Finding } from '@sparkforensics/core/types.ts';
import { worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { CHART_COLORS } from '@/view/charts/ChartTheme';

/** MiniMap node fill. A plan node is colored by the worst finding band on it so
 * the overview shows where the problems are; a plan node with no finding keeps
 * the neutral plan color, and the (large) group boxes recede into a muted fill
 * so they don't drown out the node dots. */
export function planGraphMiniMapNodeColor(node: Node): string {
  if (node.type !== 'planNode') return 'var(--muted)';
  const findings = (node.data as { findings?: Finding[] }).findings ?? [];
  const worst = worstImpactBand(findings);
  return worst ? CHART_COLORS[worst] : 'var(--plan-aggregate)';
}
