import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { PlanRowStatus } from './PlanRowStatus';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { nestedLoopJoinModel, type NestedLoopJoinRow } from './NestedLoopJoin.rows';

function Row({ row: { finding, stageIds, headline, detail } }: FindingRowProps<NestedLoopJoinRow>) {
  return (
    <>
      {stageIds.length > 0 ? <StagePillGroup pills={stageIds.map((id) => ({ id }))} /> : null}
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      {headline === null ? null : <p>{headline} <ImpactEstimate finding={finding} /></p>}
    </>
  );
}

/** A BroadcastNestedLoopJoin or CartesianProduct whose output rows are far above both inputs. */
export const NestedLoopJoin = defineFindingWidget(nestedLoopJoinModel, { Row, Status: PlanRowStatus });
