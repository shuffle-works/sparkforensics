import type { NodeProps } from '@xyflow/react';
import { Chip } from '@/view/ImpactBadge';
import { cn } from '@/lib/utils';
import type { PlanGraphSegmentGroupNodeData } from '@sparkforensics/core/types.ts';

export type PlanGraphSegmentGroupNodeProps = NodeProps & { data: PlanGraphSegmentGroupNodeData };

// A segment inside a stage box is an unstroked fill: invisible when it is the
// stage's only segment, a soft band when the stage holds several. It takes no
// clicks, so the stage box above it stays the target. The stage box carries the
// name, duration, chips and selection ring. A segment matched to no
// stage has no stage box around it, so it keeps its own dashed box and header.
export function PlanGraphSegmentGroupNode({ data }: PlanGraphSegmentGroupNodeProps) {
  const { width, height, stageId, durationLabel, sharesStage } = data;
  if (stageId == null) {
    return (
      <div
        className="overflow-hidden rounded-lg border border-dashed border-border/70 bg-muted/10 nopan nodrag"
        style={{ width, height, pointerEvents: 'all' }}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-xs text-muted-foreground">
          <span title="This plan segment couldn't be matched to a specific Spark stage">Stage —</span>
          <Chip label={durationLabel ?? '—'} impactBand="info" title="Approximate share of this stage's wall time" />
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn('rounded-lg', sharesStage && 'bg-primary/10')}
      style={{ width, height, pointerEvents: 'none' }}
    />
  );
}
