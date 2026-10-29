import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { PlanRowStatus } from './PlanRowStatus';
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

/** A query plan that repeats an identical subtree, wasting compute the planner could share. */
export const DuplicatePlanSubtree = defineFindingWidget(duplicatePlanSubtreeModel, { Row, Status: PlanRowStatus });
