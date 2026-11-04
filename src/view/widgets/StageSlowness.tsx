import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactDot } from '@/view/ImpactBadge';
import { StageHeader } from '@/view/StageHeader';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { metricLabel, stageSlownessModel, type StageSlownessRow } from './StageSlowness.rows';

function Row({ row: { finding, stated }, appModel }: FindingRowProps<StageSlownessRow>) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ImpactDot impactBand={finding.impactBand} />
        {finding.stageId != null ? <StageHeader stageId={finding.stageId} appModel={appModel} stated={stated} /> : null}
        {stated ? null : <strong>{metricLabel(finding)}</strong>}
      </div>
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** A stage whose wall-clock duration crossed the absolute-duration floor, suppressed when `slowHost`
 * already fired for the same stage (see `suppressedBy` on the entry in `detectors/stage-slowness/detect.ts`). */
export const StageSlowness = defineFindingWidget(stageSlownessModel, { Row });
