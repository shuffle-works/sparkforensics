import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { unprunedScanModel, type UnprunedScanRow } from './UnprunedScan.rows';

function Row({ row: { finding, stageIds, detail, headline } }: FindingRowProps<UnprunedScanRow>) {
  return (
    <>
      {stageIds.length > 0 ? <StagePillGroup pills={stageIds.map((id) => ({ id }))} /> : null}
      <p>
        <span className="font-medium">{finding.relation}</span>
        {' '}
        <span className="text-muted-foreground">{detail}</span>
      </p>
      {headline === null ? null : <p>{headline}</p>}
    </>
  );
}

// `sqlPlan` is a widget-wide evidence constant (this detector always reads the resolved SQL plan),
// so it sits on the header once, not per row.
const Status: NonNullable<FindingWidgetView<UnprunedScanRow>['Status']> = ({ rows: [{ finding }], density }) => (
  density === 'advanced' ? (
    <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} evidenceKey="sqlPlan" />
  ) : null
);

/** A filtered scan of a partitioned table with no partition filter. */
export const UnprunedScan = defineFindingWidget(unprunedScanModel, { Row, Status });
