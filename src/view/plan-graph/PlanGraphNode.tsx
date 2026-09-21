import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { NODE_WIDTH, NODE_HEIGHT } from '@/view/plan-graph/dagre-layout';
import { ImpactDot, IMPACT_BG_CLASS, IMPACT_TEXT_CLASS } from '@/view/ImpactBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { heatBand } from '@/view/plan-graph/plan-graph-heat';
import { typeTag } from '@sparkforensics/core/format-utils.ts';
import { findingActionLabel } from '@/view/finding-action-label';
import type { Finding, PlanGraphNodeData } from '@sparkforensics/core/types.ts';

export const CATEGORY_ICON: Record<string, string> = {
  scan: '⇩', exchange: '⇄', join: '⋈', aggregate: 'Σ', sort: '↕',
  filter: '∇', aqe: '⚙', boilerplate: '·', transform: '→',
};

/** The single finding whose band drives the badge's color and tag: the
 * highest-severity one on this node (critical > warning > info), falling back
 * to the first when none are elevated. */
function worstFinding(findings: Finding[]): Finding {
  return (
    findings.find((f) => f.impactBand === 'critical') ??
    findings.find((f) => f.impactBand === 'warning') ??
    findings[0]
  );
}

export type PlanGraphNodeProps = NodeProps & {
  data: PlanGraphNodeData & { durationSharePct: number | null };
};

export function PlanGraphNode({ data }: PlanGraphNodeProps) {
  const { label, operatorDetail, primaryMetric, category, splitRole, durationSharePct, findings } = data;
  const icon = CATEGORY_ICON[category] ?? CATEGORY_ICON.transform;
  const band = heatBand(durationSharePct);

  return (
    <div
      className="relative flex flex-col overflow-visible rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm"
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      data-category={category}
    >
      {/* opacity-0!: xyflow's default handle dot used to be fully clipped (and
          so invisible) by this card's old overflow-hidden; overflow-visible
          (below, for the finding badge) would otherwise un-clip it into a
          small dark circle on every node's left/right edge. Keep the
          pre-existing "handles are invisible" look explicitly instead of
          inheriting that as an accidental side effect. */}
      <Handle type="target" position={Position.Right} className="opacity-0!" />
      <Handle type="source" position={Position.Left} className="opacity-0!" />
      {findings && findings.length > 0 ? (() => {
        const worst = worstFinding(findings);
        return (
          // Tooltip.Provider is hoisted to the canvas root (PlanGraphCanvas), so
          // this per-node badge only mounts the trigger/content, not its own
          // provider (that multiplied by node count on a large plan).
          <Tooltip>
            <TooltipTrigger
              data-testid="node-finding-badge"
              className={cn(
                'absolute -right-1 -top-1 flex items-center gap-1 rounded-full bg-card px-1.5 py-0.5 text-[10px] font-medium leading-none shadow-sm ring-1 ring-border',
                IMPACT_TEXT_CLASS[worst.impactBand],
              )}
            >
              <ImpactDot impactBand={worst.impactBand} />
              {typeTag(worst.type)}
              {findings.length > 1 ? <span>{findings.length}</span> : null}
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <ul className="flex flex-col gap-1 text-left">
                {findings.map((f, i) => (
                  <li key={f.id ?? `${f.type}-${i}`} className="flex items-center gap-1.5">
                    <ImpactDot impactBand={f.impactBand} />
                    <span>{findingActionLabel(f)}</span>
                  </li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        );
      })() : null}
      {splitRole === 'read' ? (
        <p className="truncate text-xs text-muted-foreground">paired: see write half</p>
      ) : null}
      {durationSharePct != null && band ? (
        <div
          className="mb-1 flex shrink-0 items-center gap-1.5"
          title="Share of the plan's total stage wall time"
        >
          {/* The number leads (not trails) the bar: the finding badge floats over
              the card's top-right corner, so a right-aligned percentage collided
              with it. It is also a non-color cue: the band's low/medium/high
              can't be the only carrier of magnitude (a color-blind or grayscale
              reader gets nothing from the fill alone). */}
          <span className={cn('shrink-0 text-[10px] font-medium tabular-nums', IMPACT_TEXT_CLASS[band])}>
            {durationSharePct}%
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              data-testid="duration-heat-bar-fill"
              className={cn('h-full rounded-full', IMPACT_BG_CLASS[band])}
              // Floor a real, nonzero share to a visible sliver so a
              // small-but-present operator still reads as > 0 on the bar.
              style={{ width: `${durationSharePct > 0 ? Math.max(durationSharePct, 4) : 0}%` }}
            />
          </div>
          <span className="sr-only">
            Duration share {durationSharePct}%, {band === 'critical' ? 'high' : band === 'warning' ? 'medium' : 'low'}
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true" className="shrink-0">{icon}</span>
        <span className="min-w-0 truncate font-medium" title={label}>{label}</span>
      </div>
      {operatorDetail ? (
        <p className="truncate text-muted-foreground" title={operatorDetail}>{operatorDetail}</p>
      ) : null}
      {primaryMetric ? (
        <p className="truncate text-muted-foreground" title={primaryMetric}>{primaryMetric}</p>
      ) : null}
    </div>
  );
}
