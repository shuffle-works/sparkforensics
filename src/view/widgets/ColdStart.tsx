import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactDot } from '@/view/ImpactBadge';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { coldStartModel, metricLabel, type ColdStartRow } from './ColdStart.rows';

function Row({ row: { finding } }: FindingRowProps<ColdStartRow>) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ImpactDot impactBand={finding.impactBand} />
        <strong>{metricLabel(finding)}</strong>
      </div>
      <ImpactEstimate finding={finding} />
    </>
  );
}

/** The gap between app start and the first stage submission. App-scoped (`stageId` is always `null`). */
export const ColdStart = defineFindingWidget(coldStartModel, { Row });
