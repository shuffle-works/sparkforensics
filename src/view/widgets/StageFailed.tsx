import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactDot } from '@/view/ImpactBadge';
import { StagePill } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { stageFailedModel, type StageFailedRow } from './StageFailed.rows';

function Row({ row: { finding, stageId, stated } }: FindingRowProps<StageFailedRow>) {
  return (
    <>
      {stated ? null : (
        <div className="flex items-center gap-2">
          <StagePill stageId={stageId} />
          <ImpactDot impactBand={finding.impactBand} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {stated ? null : 'Stage attempt failed outright. '}Reason: <strong>{finding.valueText}</strong>
      </p>
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** Outright `stageFailed` attempts: every flagged stage gets its own row (never just the worst). */
export const StageFailed = defineFindingWidget(stageFailedModel, { Row });
