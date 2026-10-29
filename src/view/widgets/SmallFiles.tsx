import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { PlanRowStatus } from './PlanRowStatus';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { smallFilesModel, type SmallFilesRow } from './SmallFiles.rows';

function Row({ row: { finding, stageIds, headline, detail } }: FindingRowProps<SmallFilesRow>) {
  return (
    <>
      {stageIds.length > 0 ? <StagePillGroup pills={stageIds.map((id) => ({ id }))} /> : null}
      {headline === null ? null : <p>{headline} <ImpactEstimate finding={finding} /></p>}
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </>
  );
}

/** A scan reading many small input files, wasting task-scheduling overhead a coalesce/repartition
 * upstream would avoid. */
export const SmallFiles = defineFindingWidget(smallFilesModel, { Row, Status: PlanRowStatus });
