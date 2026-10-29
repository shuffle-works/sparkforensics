import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { PlanRowStatus } from './PlanRowStatus';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { underBroadcastModel, type UnderBroadcastRow } from './UnderBroadcast.rows';

function Row({ row: { finding, headline } }: FindingRowProps<UnderBroadcastRow>) {
  return (
    <>
      {finding.stageIds.length > 0 ? <StagePillGroup pills={finding.stageIds.map((id) => ({ id }))} /> : null}
      <p>{headline} <ImpactEstimate finding={finding} /></p>
    </>
  );
}

/** A join whose small build side stayed a shuffle join instead of broadcasting. */
export const UnderBroadcast = defineFindingWidget(underBroadcastModel, { Row, Status: PlanRowStatus });
