import { cn } from '@/lib/utils';
import { StagePill } from '@/view/StagePill';
import type { AppModel } from '@sparkforensics/core/types.ts';

/** Stage-pill + stage-name row header, shared by Skew, StageShape, TinyTask,
 * GcPressure, ShuffleIO, and PartitionSizing. Spill uses a different per-row
 * pattern instead: its rows lead with a per-finding-type `TagBadge` that this
 * component doesn't carry. */
export function StageHeader({
  stageId,
  appModel,
  stated = false,
}: {
  stageId: number;
  appModel: AppModel;
  /** The line above an evidence panel already names the stage: only the stage's name and call site remain. */
  stated?: boolean;
}) {
  const stage = appModel.stages.get(stageId);
  if (stated && !stage?.name) return null;
  return (
    // Without its chip, the name shares a line with the dot beside it, wrapping inside its own box.
    <div className={cn('flex flex-wrap items-center gap-2', stated && 'min-w-0 flex-1 basis-40')}>
      {stated ? null : <StagePill stageId={stageId} />}
      <span className="text-sm font-medium">{stage?.name ?? `Stage ${stageId}`}</span>
    </div>
  );
}
