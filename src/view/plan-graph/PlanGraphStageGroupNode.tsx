import type { NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { PlanGraphFindingChip } from './PlanGraphFindingChip';
import { StageEntryButton, useStageSelection } from './stage-selection';
import type { PlanGraphStageGroupNodeData } from '@sparkforensics/core/types.ts';

export type PlanGraphStageGroupNodeProps = NodeProps & { data: PlanGraphStageGroupNodeData };

// Outer group layer: a solid tinted field wrapping every segment box zipped to
// the same stage. Findings are stage-scoped but render inline in the matched
// segment box's header row, not here, so a stage split across segments doesn't
// get two rows of chips. showOwnFindings is the exception: a focal stage the zip
// left with no matching segment box paints its chips here as a fallback. That
// box wraps the whole graph, so the chips sit above its top edge, clear of the
// headers of the boxes inside it.
// Otherwise this box paints only a corner "Stage N" tag, opposite the segment
// box's top-left header so the two don't collide.
export function PlanGraphStageGroupNode({ data }: PlanGraphStageGroupNodeProps) {
  const { width, height, stageId, findings, showOwnFindings = true, onSelect } = data;
  const selected = useStageSelection()?.selectedStageId === stageId;
  return (
    <div
      className={cn('relative rounded-xl border border-primary/25 bg-primary/5 nopan nodrag', selected && 'ring-2 ring-primary')}
      style={{ width, height, pointerEvents: 'all' }}
    >
      {/* Overlay click target, painted first so it sits behind the findings
          chips/label below in stacking order. */}
      <button
        type="button"
        aria-label={`Focus stage ${stageId}`}
        onClick={onSelect}
        style={{ pointerEvents: 'auto' }}
        className="absolute inset-0 size-full cursor-pointer rounded-xl transition-colors hover:border-primary/50 hover:bg-primary/10"
      />
      {showOwnFindings && findings.length > 0 ? (
        // Anchored to the top edge and growing upward, so many chips wrap into
        // more rows above the box instead of down over the boxes inside it.
        <div className="absolute bottom-full left-0 right-0 mb-1 flex flex-wrap items-end gap-1">
          {findings.map((f, i) => (
            <PlanGraphFindingChip key={f.id ?? `${f.type}-${i}`} finding={f} stageId={stageId} className="h-4 gap-1 px-1.5 text-xs" />
          ))}
        </div>
      ) : null}
      {/* Full-strength primary, not /70: at 70% opacity over the tinted field
          this dropped to ~2.8:1, under the 4.5:1 floor for 12px text. The
          wrapper positions it: the button's hit-area class sets its own
          `position`. */}
      <span className="absolute right-2 bottom-1 text-xs font-medium text-primary">
        <StageEntryButton stageId={stageId} aria-label={`Show the findings for stage ${stageId}`} className="hover:underline">
          Stage {stageId}
        </StageEntryButton>
      </span>
    </div>
  );
}
