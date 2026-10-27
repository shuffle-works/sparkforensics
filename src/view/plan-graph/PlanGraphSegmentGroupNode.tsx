import type { NodeProps } from '@xyflow/react';
import { Chip } from '@/view/ImpactBadge';
import type { PlanGraphSegmentGroupNodeData } from '@sparkforensics/core/types.ts';

export type PlanGraphSegmentGroupNodeProps = NodeProps & { data: PlanGraphSegmentGroupNodeData };

// A plan segment with no stage pair of its own. Nothing in the log ties it to a
// stage, so it is not drawn inside a stage box: it keeps this dashed box and
// names the nearest paired stage as a hint, not as membership.
export function PlanGraphSegmentGroupNode({ data }: PlanGraphSegmentGroupNodeProps) {
  const { width, height, nearestStageId, durationLabel } = data;
  return (
    <div
      className="overflow-hidden rounded-lg border border-dashed border-border/70 bg-muted/10 nopan nodrag"
      style={{ width, height, pointerEvents: 'all' }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-xs text-muted-foreground">
        <span title="This plan segment has no Spark stage of its own in the log">Stage —</span>
        {nearestStageId != null ? <span title="The closest stage the log pairs with a plan segment">nearest: Stage {nearestStageId}</span> : null}
        <Chip label={durationLabel ?? '—'} impactBand="info" title="Approximate share of this stage's wall time" />
      </div>
    </div>
  );
}
