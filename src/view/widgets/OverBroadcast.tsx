import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { overBroadcastModel, type OverBroadcastRow } from './OverBroadcast.rows';

function Row({ row: { finding, headline } }: FindingRowProps<OverBroadcastRow>) {
  return (
    <>
      {finding.stageIds.length > 0 ? <StagePillGroup pills={finding.stageIds.map((id) => ({ id }))} /> : null}
      <p>{headline} <ImpactEstimate finding={finding} /></p>
    </>
  );
}

const Status: NonNullable<FindingWidgetView<OverBroadcastRow>['Status']> = ({ rows: [{ finding }], density }) => (
  density === 'advanced' ? (
    <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} evidenceKey="sqlPlan" />
  ) : null
);

/** A broadcast join whose build side turned out larger than the threshold assumed, risking an out-of-memory executor. */
export const OverBroadcast = defineFindingWidget(overBroadcastModel, { Row, Status });
