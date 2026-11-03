import { formatBytes } from '@sparkforensics/core/view-model';
import { StageHeader } from '@/view/StageHeader';
import { StagePillGroup } from '@/view/StagePill';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { PartitionHint } from './PartitionHint';
import { PlanExplorer } from './PlanExplorer';
import { shuffleModel, type ShuffleRow } from './ShuffleIO.rows';

function Row({ row: { finding, stageId, stated, usage, detail, partitionHint, showPlanExplorer }, appModel }: FindingRowProps<ShuffleRow>) {
  return (
    <>
      <StageHeader stageId={stageId} appModel={appModel} stated={stated} />
      {usage ? (
        <p className="text-sm">
          {usage.readBytes === null ? null : (
            <>
              Shuffle read: <strong>{formatBytes(usage.readBytes)}</strong>
              {' · '}
            </>
          )}
          Write: {formatBytes(usage.writeBytes)}
        </p>
      ) : null}
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      {stated ? null : <ImpactEstimate finding={finding} />}
      {partitionHint || showPlanExplorer ? (
        <div className="space-y-2 pt-1">
          {partitionHint ? <PartitionHint hint={partitionHint} /> : null}
          {showPlanExplorer ? <PlanExplorer stageId={stageId} appModel={appModel} /> : null}
        </div>
      ) : null}
    </>
  );
}

// A stage the line above an evidence panel names needs no pill.
const Lead: NonNullable<FindingWidgetView<ShuffleRow>['Lead']> = ({ rows }) => {
  const pills = rows.filter((row) => !row.stated).map((row) => ({ id: row.stageId }));
  return pills.length > 0 ? <div className="mb-4"><StagePillGroup pills={pills} /></div> : null;
};

/** Shuffle read/write board. Serves the `shuffle` detector type only. */
export const ShuffleIO = defineFindingWidget(shuffleModel, { Row, Lead });
