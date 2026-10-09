import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { formatBytes } from '@sparkforensics/core/format-utils.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { exchangeEdgeStrokeWidth, exchangeEdgeOpacity } from './plan-graph-edge';

/** Data carried on a weighted exchange edge (set in PlanGraphCanvas). */
export interface ExchangeEdgeData {
  shuffleBytes: number;
  /** The heaviest exchange in the current graph, for relative scaling. */
  maxShuffleBytes: number;
  [key: string]: unknown;
}

/** A read->write exchange edge weighted by shuffle bytes: thicker and more
 * opaque the more data crossed it, with a terse monospace byte label at the
 * midpoint. Neutral single hue only (var(--text-muted)); status colors stay
 * reserved for findings, per DESIGN.md. */
export function PlanGraphExchangeEdge({
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  const { shuffleBytes = 0, maxShuffleBytes = 0 } = (data ?? {}) as Partial<ExchangeEdgeData>;
  const strokeWidth = exchangeEdgeStrokeWidth(shuffleBytes, maxShuffleBytes);
  const strokeOpacity = exchangeEdgeOpacity(shuffleBytes, maxShuffleBytes);
  // formatBytes has no sub-KB tier (a guarded decision, see partition-sizing
  // test) and would render a real but tiny shuffle as a misleading "0 KB".
  const label = shuffleBytes > 0 && shuffleBytes < 1000 ? '<1 KB' : formatBytes(shuffleBytes);

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={{ stroke: 'var(--text-muted)', strokeWidth, strokeOpacity }} />
      <EdgeLabelRenderer>
        {/* Tooltip.Provider is hoisted to the canvas root (PlanGraphCanvas), so
            this per-edge label only mounts the trigger/content. */}
        <Tooltip>
          <TooltipTrigger
            data-testid="exchange-edge-label"
            // EdgeLabelRenderer's container is pointer-events:none; the label
            // must opt back in to be hoverable. nodrag/nopan keep a hover over
            // the chip from starting a canvas pan/drag.
            className="nodrag nopan pointer-events-auto absolute cursor-help rounded bg-card/90 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground ring-1 ring-border"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p>
              {label} of shuffle written across this exchange.
              Edge thickness scales with the volume moved.
            </p>
          </TooltipContent>
        </Tooltip>
      </EdgeLabelRenderer>
    </>
  );
}
