import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { duplicatePlanSubtreeModel, type DuplicatePlanSubtreeRow } from './DuplicatePlanSubtree.rows';

function Row({ row: { finding, headline } }: FindingRowProps<DuplicatePlanSubtreeRow>) {
  return (
    <>
      {finding.stageIds.length > 0 ? <StagePillGroup pills={finding.stageIds.map((id) => ({ id }))} /> : null}
      <p>{headline} <ImpactEstimate finding={finding} /></p>
    </>
  );
}

// Only one confidence is claimed on the header when every row shares it; a mixed group would
// otherwise show one finding's confidence as if it applied to all of them.
const Status: NonNullable<FindingWidgetView<DuplicatePlanSubtreeRow>['Status']> = ({ rows, density }) => {
  const shared = rows.every(({ finding }) => finding.confidence === rows[0].finding.confidence) ? rows[0].finding : undefined;
  return density === 'advanced' ? (
    <RowStatusCluster confidence={shared?.confidence} validationRequired={shared?.validationRequired} evidenceKey="sqlPlan" />
  ) : null;
};

/** A query plan that repeats an identical subtree, wasting compute the planner could share. */
export const DuplicatePlanSubtree = defineFindingWidget(duplicatePlanSubtreeModel, { Row, Status });
