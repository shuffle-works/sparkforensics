import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { mergeRewriteModel, type MergeRewriteRow } from './MergeRewrite.rows';

function Row({ row: { finding, stated, stageIds, label, measurement } }: FindingRowProps<MergeRewriteRow>) {
  return (
    <>
      {stageIds.length > 0 ? <StagePillGroup pills={stageIds.map((id) => ({ id }))} /> : null}
      <p>
        <span className="font-medium">{label}</span>
        {' '}
        <span className="text-muted-foreground">{measurement}</span>
        {' '}
        {stated ? null : <ImpactEstimate finding={finding} />}
      </p>
    </>
  );
}

const Status: NonNullable<FindingWidgetView<MergeRewriteRow>['Status']> = ({ rows: [{ finding }], density }) => (
  density === 'advanced' ? (
    <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} evidenceKey="sqlPlan" />
  ) : null
);

/** A MERGE that rewrote mostly unmodified rows or kept most target files after skipping. */
export const MergeRewrite = defineFindingWidget(mergeRewriteModel, { Row, Status });
