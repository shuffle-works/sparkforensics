import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
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

const Status: NonNullable<FindingWidgetView<UnderBroadcastRow>['Status']> = ({ rows: [{ finding }], density }) => (
  density === 'advanced' ? (
    <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} evidenceKey="sqlPlan" />
  ) : null
);

/** A join whose small build side stayed a shuffle join instead of broadcasting. */
export const UnderBroadcast = defineFindingWidget(underBroadcastModel, { Row, Status });
