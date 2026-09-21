import type { NodeProps } from '@xyflow/react';
import { PlanGraphFindingChip } from './PlanGraphFindingChip';
import type { PlanGraphStageGroupNodeData } from '@sparkforensics/core/types.ts';

export type PlanGraphStageGroupNodeProps = NodeProps & { data: PlanGraphStageGroupNodeData };

// Outer group layer: a solid tinted field wrapping every segment box zipped to
// the same stage. Findings are stage-scoped but render inline in the matched
// segment box's header row, not here, so a stage split across segments doesn't
// get two rows of chips. showOwnFindings is the exception: a focal stage the zip
// left with no matching segment box paints its chips here as a fallback.
// Otherwise this box paints only a corner "Stage N" tag, opposite the segment
// box's top-left header so the two don't collide.
export function PlanGraphStageGroupNode({ data }: PlanGraphStageGroupNodeProps) {
  const { width, height, stageId, findings, showOwnFindings = true, onSelect } = data;
  return (
    <div
      className="relative rounded-xl border border-primary/25 bg-primary/5 nopan nodrag"
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
        // right-2 bounds this to the box width so many chips wrap down instead
        // of running off the right edge over the next stage box.
        <div className="absolute left-2 right-2 top-1 flex flex-wrap gap-1">
          {findings.map((f, i) => (
            <PlanGraphFindingChip key={f.id ?? `${f.type}-${i}`} finding={f} className="h-4 gap-1 px-1.5 text-xs" />
          ))}
        </div>
      ) : null}
      {/* Full-strength primary, not /70: at 70% opacity over the tinted field
          this dropped to ~2.8:1, under the 4.5:1 floor for 12px text. */}
      <span className="absolute right-2 bottom-1 text-xs font-medium text-primary">
        Stage {stageId}
      </span>
    </div>
  );
}
