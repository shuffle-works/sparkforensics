import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
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

// `sqlPlan` is a widget-wide evidence constant (this detector always reads the resolved SQL plan),
// so it sits on the header once, not per row.
const Status: NonNullable<FindingWidgetView<NestedLoopJoinRow>['Status']> = ({ rows: [{ finding }], density }) => (
  density === 'advanced' ? (
    <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} evidenceKey="sqlPlan" />
  ) : null
);

/** A BroadcastNestedLoopJoin or CartesianProduct whose output rows are far above both inputs. */
export const NestedLoopJoin = defineFindingWidget(nestedLoopJoinModel, { Row, Status });
