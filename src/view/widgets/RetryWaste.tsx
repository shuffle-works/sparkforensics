import { formatDuration, numericValue } from '@sparkforensics/core/format-utils.ts';
import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactDot } from '@/view/ImpactBadge';
import { StagePill } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { retryWasteModel, type RetryWasteRow } from './RetryWaste.rows';

function Row({ row: { finding, stageId, stated, extension } }: FindingRowProps<RetryWasteRow>) {
  return (
    <>
      {stated ? null : (
        <div className="flex items-center gap-2">
          <StagePill stageId={stageId} />
          <ImpactDot impactBand={finding.impactBand} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {stated ? null : <>Wasted <strong>{formatDuration(numericValue(finding))}</strong> of executor time.</>}
        {extension ? ` ${extension}` : null}
      </p>
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** Retried task attempts that wasted executor time even though the stage ultimately completed. */
export const RetryWaste = defineFindingWidget(retryWasteModel, { Row });
