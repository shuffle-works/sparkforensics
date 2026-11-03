import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { PlanRowStatus } from './PlanRowStatus';
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

/** A filtered scan of a partitioned table with no partition filter. */
export const UnprunedScan = defineFindingWidget(unprunedScanModel, { Row, Status: PlanRowStatus });
