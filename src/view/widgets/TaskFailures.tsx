import { formatTaskFailureHeadline, type TaskFailureGroup } from '@sparkforensics/core/task-failure.ts';
import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactDot } from '@/view/ImpactBadge';
import { StagePill } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { taskFailuresModel, type TaskFailuresRow } from './TaskFailures.rows';

// One entry per distinct error, each with its bounded stack excerpt (task-failure.ts).
function FailureGroupList({ groups, otherFailedTasks }: { groups: TaskFailureGroup[]; otherFailedTasks: number }) {
  if (groups.length === 0) return null;
  return (
    <ul className="space-y-2" aria-label="Distinct failures">
      {groups.map((g, i) => (
        <li key={i} className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {g.count} task{g.count === 1 ? '' : 's'}: <strong className="break-words">{formatTaskFailureHeadline(g)}</strong>
          </p>
          {g.stackExcerpt ? (
            <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre">{g.stackExcerpt}</pre>
          ) : null}
        </li>
      ))}
      {otherFailedTasks > 0 ? (
        <li className="text-xs text-muted-foreground">
          {otherFailedTasks} more failed task{otherFailedTasks === 1 ? '' : 's'} not shown
        </li>
      ) : null}
    </ul>
  );
}

function Row({ row: { finding, stageId, stated, dominantError } }: FindingRowProps<TaskFailuresRow>) {
  return (
    <>
      {stated ? null : (
        <div className="flex items-center gap-2">
          <StagePill stageId={stageId} />
          <ImpactDot impactBand={finding.impactBand} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {stated ? (
          <><strong>{finding.failedTasks}</strong> failed tasks</>
        ) : (
          <>
            Failure rate: <strong>{finding.value}%</strong> ({finding.failedTasks} tasks) &middot; Dominant
            error: <strong className="break-words">{dominantError ?? '—'}</strong>
          </>
        )}
      </p>
      <FailureGroupList
        groups={finding.failureGroups}
        otherFailedTasks={finding.otherFailedTasks}
      />
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** Task-level `failures` findings: every flagged stage gets its own row (never just the worst). */
export const TaskFailures = defineFindingWidget(taskFailuresModel, { Row });
