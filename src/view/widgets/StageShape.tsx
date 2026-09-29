import { memo } from 'react';

import type { WidgetProps } from '@/view/detector-registry';
import type { Finding, FindingOf } from '@sparkforensics/core/types.ts';
import { StageFindingGroupWidget } from './StageFindingGroup';

// `stageShape`'s `rule` field names the shape smell it detected; turn it into a
// short human label.
const STAGE_SHAPE_RULE_LABEL: Record<FindingOf<'stageShape'>['rule'], string> = {
  lowParallelism: 'Low parallelism',
  dataExplosion: 'Data explosion',
  taskStageSkew: 'Task/stage skew',
};

function findingLabel(f: Finding): string {
  // StageFindingGroupWidget only passes this board's own `stageShape` findings.
  const label = f.type === 'stageShape' ? STAGE_SHAPE_RULE_LABEL[f.rule] : 'stage shape';
  return f.type === 'stageShape' && f.rule === 'lowParallelism' ? `${label}: ${f.value} tasks per core` : `${label}: ${f.value}`;
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
