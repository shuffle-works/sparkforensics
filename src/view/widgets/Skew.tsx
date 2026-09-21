import { memo } from 'react';

import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { formatMetricValue, numericValue } from '@sparkforensics/core/format-utils.ts';
import { StageFindingGroupWidget } from './StageFindingGroup';

function findingLabel(f: Finding): string {
  return `${f.metric}: ${formatMetricValue('ratio', numericValue(f))}`;
}

export type SkewProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'getTaskData' | 'defaultCollapsed'>;

/** Per-stage task-duration skew board: flags every stage carrying a `skew`
 * finding (never just the worst one). Thin wrapper around the shared
 * `StageFindingGroupWidget` (`StageFindingGroup.tsx`), which owns the
 * row/card/pagination scaffold this shares with its two siblings,
 * `StageShape.tsx` and `TinyTask.tsx`. */
export const Skew = memo(function Skew(props: SkewProps) {
  return <StageFindingGroupWidget {...props} type="skew" title="Task Skew" idPrefix="skew" findingLabel={findingLabel} />;
});
