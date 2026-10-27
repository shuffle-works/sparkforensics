import type { NodeProps } from '@xyflow/react';
import { Chip } from '@/view/ImpactBadge';
import { cn } from '@/lib/utils';
import { PlanGraphFindingChip } from './PlanGraphFindingChip';
import { StageEntryButton, useStageSelection } from './stage-selection';
import type { PlanGraphStageGroupNodeData, PlanGraphUnmatchedStageNodeData } from '@sparkforensics/core/types.ts';

export type PlanGraphStageGroupNodeProps = NodeProps & { data: PlanGraphStageGroupNodeData };
export type PlanGraphUnmatchedStageNodeProps = NodeProps & { data: PlanGraphUnmatchedStageNodeData };

// The stage's name, duration and finding chips. Only its contents take clicks:
// the rest of the row belongs to whatever is behind it. Full-strength primary,
// not /70: at 70% opacity over the tinted field the title dropped to ~2.8:1,
// under the 4.5:1 floor for 12px text.
function StageHeader({ stageId, durationLabel, findings, className }: Pick<PlanGraphStageGroupNodeData, 'stageId' | 'durationLabel' | 'findings'> & { className?: string }) {
  return (
    <div className={cn('pointer-events-none flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-primary [&>*]:pointer-events-auto', className)}>
      <StageEntryButton stageId={stageId} aria-label={`Show the findings for stage ${stageId}`} className="hover:underline">
        Stage {stageId}
      </StageEntryButton>
      {durationLabel ? <Chip label={durationLabel} impactBand="info" title="Approximate share of this stage's wall time" /> : null}
      {findings.map((f, i) => (
        <PlanGraphFindingChip key={f.id ?? `${f.type}-${i}`} finding={f} stageId={stageId} className="h-4 gap-1 px-1.5 text-xs" />
      ))}
    </div>
  );
}

// The one stroked box of a stage, wrapping the segment paired with it. It owns
// the stage's name, duration, finding chips and selection ring.
export function PlanGraphStageGroupNode({ data }: PlanGraphStageGroupNodeProps) {
  const { width, height, stageId, findings, durationLabel, onSelect } = data;
  const selected = useStageSelection()?.selectedStageId === stageId;
  return (
    <div
      className={cn('relative rounded-xl border border-primary/45 bg-primary/5 nopan nodrag', selected && 'ring-2 ring-primary')}
      style={{ width, height, pointerEvents: 'all' }}
    >
      {/* Overlay click target, painted first so it sits behind the header below
          in stacking order. Only a box with somewhere to go is a target. */}
      {onSelect ? (
        <button
          type="button"
          aria-label={`Focus stage ${stageId}`}
          onClick={onSelect}
          style={{ pointerEvents: 'auto' }}
          className="absolute inset-0 size-full cursor-pointer rounded-xl transition-colors hover:border-primary/50 hover:bg-primary/10"
        />
      ) : null}
      {/* The header spans the box so its chips can wrap. */}
      <StageHeader stageId={stageId} durationLabel={durationLabel} findings={findings} className="absolute left-2 right-2 top-2" />
    </div>
  );
}

// A focal stage with findings but no segment paired with it: no box, just its
// header above the graph, anchored to the bottom so a wrapped row grows upward
// instead of over the graph.
export function PlanGraphUnmatchedStageNode({ data }: PlanGraphUnmatchedStageNodeProps) {
  const { width, height, stageId, findings, durationLabel } = data;
  return (
    <div className="pointer-events-none flex flex-col justify-end gap-1 nopan nodrag" style={{ width, height }}>
      <StageHeader stageId={stageId} durationLabel={durationLabel} findings={findings} />
      <span className="text-xs text-muted-foreground">Not matched to a part of this plan</span>
    </div>
  );
}
