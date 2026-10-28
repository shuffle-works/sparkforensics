import type { ReactNode } from 'react';

import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { AppModel, StageId, TaskData } from '@sparkforensics/core/types.ts';
import { DurationHistogram } from '@/view/charts/DurationHistogram';
import { ExpandToggleButton } from '@/view/ExpandToggleButton';
import { useExpandableRow } from '@/view/useExpandableRow';
import { useLiveTaskData } from '@/view/useLiveTaskData';

/** A stage's task duration spread: the P50/P95/Max line and a "Task detail" disclosure that
 * fetches the stage's tasks and draws their duration histogram. `between` renders between the
 * line and the disclosure, `children` inside the disclosure under the histogram. `p50Stated`
 * drops the P50 figure when the line above states it. An exported report carries no task data, so
 * its disclosure exists only when `children` give it something to show. */
export function StageTaskSpread({
  stageId,
  appModel,
  getTaskData,
  idPrefix,
  p50Stated = false,
  between,
  children,
}: {
  stageId: StageId;
  appModel: AppModel;
  getTaskData: (id: number) => Promise<TaskData>;
  /** Prefix for the disclosure's DOM id, e.g. `skew` gives `skew-stage-3-detail`. */
  idPrefix: string;
  p50Stated?: boolean;
  between?: ReactNode;
  children?: ReactNode;
}) {
  const { exportMode, getTaskData: liveGetTaskData } = useLiveTaskData(getTaskData);
  const { expanded, data: taskData, error: taskDataError, toggle } = useExpandableRow(
    liveGetTaskData ? () => liveGetTaskData(stageId) : undefined,
  );
  const stage = appModel.stages.get(stageId);
  const detailId = `${idPrefix}-stage-${stageId}-detail`;

  return (
    <>
      {stage?.taskDurationP50 != null ? (
        <p className="text-xs text-muted-foreground">
          {p50Stated ? null : <>P50 {formatDuration(stage.taskDurationP50)} &middot; </>}P95 {formatDuration(stage.taskDurationP95)} &middot; Max{' '}
          {formatDuration(stage.taskDurationMax)}
        </p>
      ) : null}
      {between}
      {liveGetTaskData || children ? (
        <ExpandToggleButton expanded={expanded} onClick={toggle} label="Task detail" location={`Stage ${stageId}`} controlsId={detailId} />
      ) : null}
      {expanded ? (
        <div id={detailId} className="space-y-3 pt-1">
          {taskData ? (
            <DurationHistogram
              metrics={taskData.metrics}
              fieldNames={taskData.fieldNames}
              markers={{ p50: stage?.taskDurationP50, p95: stage?.taskDurationP95 }}
            />
          ) : exportMode ? (
            <p className="text-xs text-muted-foreground">Task data isn&rsquo;t included in exported reports.</p>
          ) : taskDataError ? (
            <p className="text-xs text-muted-foreground">Task data unavailable for this stage.</p>
          ) : (
            <p className="text-xs text-muted-foreground">Loading task data&hellip;</p>
          )}
          {children}
        </div>
      ) : null}
    </>
  );
}
