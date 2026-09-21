import { memo } from 'react';

import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { StageFindingGroupWidget } from './StageFindingGroup';

// `stageShape`'s `rule` field names the shape smell it detected; turn it into a
// short human label.
const STAGE_SHAPE_RULE_LABEL: Record<string, string> = {
  lowParallelism: 'Low parallelism',
  dataExplosion: 'Data explosion',
  taskStageSkew: 'Task/stage skew',
};

function findingLabel(f: Finding): string {
  const rule = typeof f.rule === 'string' ? f.rule : undefined;
  const label = (rule && STAGE_SHAPE_RULE_LABEL[rule]) ?? f.metric ?? 'stage shape';
  return `${label}: ${f.value}`;
}

export type StageShapeProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'getTaskData' | 'defaultCollapsed'>;

/** Per-stage stage-shape findings: flags every stage carrying a `stageShape`
 * finding (never just the worst one). Thin wrapper around the shared
 * `StageFindingGroupWidget` (`StageFindingGroup.tsx`), which owns the
 * row/card/pagination scaffold this shares with its two siblings,
 * `Skew.tsx` and `TinyTask.tsx`. */
export const StageShape = memo(function StageShape(props: StageShapeProps) {
  return (
    <StageFindingGroupWidget {...props} type="stageShape" title="Stage Shape" idPrefix="stage-shape" findingLabel={findingLabel} />
  );
});
