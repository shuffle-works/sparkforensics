import { memo } from 'react';

import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { StageFindingGroupWidget } from './StageFindingGroup';

function findingLabel(f: Finding): string {
  return `P50 ${f.value}ms across many small tasks`;
}

export type TinyTaskProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'getTaskData' | 'defaultCollapsed'>;

/** Flags every stage carrying a `tinyTask` finding (never just the worst
 * one). Thin wrapper around the shared `StageFindingGroupWidget`
 * (`StageFindingGroup.tsx`), which owns the row/card/pagination scaffold
 * this shares with its two siblings, `Skew.tsx` and `StageShape.tsx`.
 * `tinyTask` findings always carry the same single metric shape
 * (`metric: 'taskDurationP50'`, see `detectors.ts`), so, unlike Skew
 * (`metric` varies) or StageShape (`rule` varies), a fixed label format is
 * correct here, not a gap to close. */
export const TinyTask = memo(function TinyTask(props: TinyTaskProps) {
  return <StageFindingGroupWidget {...props} type="tinyTask" title="Tiny Tasks" idPrefix="tiny-task" findingLabel={findingLabel} />;
});
