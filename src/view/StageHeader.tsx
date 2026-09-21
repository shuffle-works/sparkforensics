import { StagePill } from '@/view/StagePill';
import type { AppModel } from '@sparkforensics/core/types.ts';

/** Stage-pill + stage-name row header, shared by Skew, StageShape, TinyTask,
 * GcPressure, ShuffleIO, and PartitionSizing. Spill uses a different per-row
 * pattern instead: its rows lead with a per-finding-type `TagBadge` that this
 * component doesn't carry. */
export function StageHeader({ stageId, appModel }: { stageId: number; appModel: AppModel }) {
  const stage = appModel.stages.get(stageId);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StagePill stageId={stageId} />
      <span className="text-sm font-medium">{stage?.name ?? `Stage ${stageId}`}</span>
    </div>
  );
}
