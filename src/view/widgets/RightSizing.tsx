import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactDot } from '@/view/ImpactBadge';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { rightSizingModel, type RightSizingRow } from './RightSizing.rows';

function Row({ row: { finding, stated, showModelError } }: FindingRowProps<RightSizingRow>) {
  const { value, observedCores, observedActiveMs, modeledActiveMs, modelErrorPct } = finding;
  return (
    <>
      {stated ? null : (
        <>
          <p className="flex flex-wrap items-start gap-2">
            <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
            <span>
              <strong>{value} of {observedCores} cores</strong> would be enough
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            The stages took {formatDuration(observedActiveMs)} on {observedCores} cores. The model predicts{' '}
            {formatDuration(modeledActiveMs)} on {value}.
          </p>
        </>
      )}
      {showModelError ? <p className="text-xs text-muted-foreground">Model error at {observedCores} cores: {modelErrorPct}%.</p> : null}
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** How many cores the run needs, from the what-if scaling model. App-scoped. */
export const RightSizing = defineFindingWidget(rightSizingModel, { Row });
