import { ImpactDot } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { StageHeader } from '@/view/StageHeader';
import { StageTaskSpread } from '@/view/StageTaskSpread';
import type { FindingRowProps } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { PlanExplorer } from './PlanExplorer';
import type { StageGroupRow, StageGroupType } from './StageGroup.rows';

/** One stage's row of a skew, stage-shape or tiny-task widget: its findings, the slow-host and
 * straggler callouts, and the expandable task duration spread with the stage's plan context. */
export function StageGroupRowBody<T extends StageGroupType>({
  row: { stageId, stageStated, entries, p50Stated, slowHost, straggler, showPlanExplorer, idPrefix },
  appModel,
  getTaskData,
}: FindingRowProps<StageGroupRow<T>>) {
  return (
    <>
      <StageHeader stageId={stageId} appModel={appModel} stated={stageStated} />
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {entries.map(({ finding, stated, label, showStatus }, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {stated ? null : (
                <>
                  <ImpactDot impactBand={finding.impactBand} />
                  <span>{label}</span>
                  <ImpactEstimate finding={finding} />
                </>
              )}
              {showStatus ? <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <StageTaskSpread
        stageId={stageId}
        appModel={appModel}
        getTaskData={getTaskData}
        idPrefix={idPrefix}
        p50Stated={p50Stated}
        between={
          <>
            {slowHost ? (
              <p className="flex items-start gap-2 text-xs">
                <ImpactDot impactBand={slowHost.impactBand} className="mt-1" />
                <span>
                  <strong>Slow host:</strong> {slowHost.host} ({slowHost.ratio}&times; median, {slowHost.taskSharePct}% of tasks)
                </span>
              </p>
            ) : null}
            {straggler ? (
              <p className="flex items-start gap-2 text-xs">
                <ImpactDot impactBand={straggler.impactBand} className="mt-1" />
                <span>
                  <strong>Stragglers:</strong> {straggler.detail}
                </span>
              </p>
            ) : null}
          </>
        }
      >
        {showPlanExplorer ? <PlanExplorer stageId={stageId} appModel={appModel} /> : null}
      </StageTaskSpread>
    </>
  );
}
