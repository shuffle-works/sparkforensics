import type { NodeProps } from '@xyflow/react';
import { Chip } from '@/view/ImpactBadge';
import { PlanGraphFindingChip } from './PlanGraphFindingChip';
import type { PlanGraphSegmentGroupNodeData } from '@sparkforensics/core/types.ts';

export type PlanGraphSegmentGroupNodeProps = NodeProps & { data: PlanGraphSegmentGroupNodeData };

export function PlanGraphSegmentGroupNode({ data }: PlanGraphSegmentGroupNodeProps) {
  const { width, height, stageId, durationLabel, findings } = data;
  return (
    <div
      className="overflow-hidden rounded-lg border border-dashed border-border/70 bg-muted/10 nopan nodrag"
      style={{ width, height, pointerEvents: 'all' }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-xs text-muted-foreground">
        <span title={stageId == null ? "This plan segment couldn't be matched to a specific Spark stage" : undefined}>
          {stageId != null ? `Stage ${stageId}` : 'Stage —'}
        </span>
        <Chip label={durationLabel ?? '—'} impactBand="info" title="Approximate share of this stage's wall time" />
        {findings.length > 0 ? (
          // min-w-0 lets this shrink to the box's remaining width so the chips
          // wrap onto more rows instead of overflowing past the box edge into a
          // neighboring stage box; overflow-hidden on the box is the backstop.
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
            {findings.map((f, i) => (
              <PlanGraphFindingChip key={f.id ?? `${f.type}-${i}`} finding={f} className="h-4 gap-1 px-1.5 text-xs" />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
