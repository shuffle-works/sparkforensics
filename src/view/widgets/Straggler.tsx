import { ImpactDot } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { StageHeader } from '@/view/StageHeader';
import { StageTaskSpread } from '@/view/StageTaskSpread';
import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { stragglerModel, type StragglerRow } from './Straggler.rows';

function Row({ row: { finding, stated, showIdentity, showStatus, detail, causeSummary, stragglerCount, showSpread }, appModel, getTaskData }: FindingRowProps<StragglerRow>) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {showIdentity ? (
          <div className="flex flex-wrap items-center gap-2">
            <ImpactDot impactBand={finding.impactBand} />
            {finding.stageId != null ? <StageHeader stageId={finding.stageId} appModel={appModel} stated={stated} /> : null}
          </div>
        ) : null}
        {showStatus ? <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} /> : null}
      </div>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      {causeSummary ? <p className="text-xs text-muted-foreground">{causeSummary}</p> : null}
      {stragglerCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {stragglerCount} straggling task{stragglerCount === 1 ? '' : 's'}, over 4&times; the stage&apos;s median task duration.
        </p>
      ) : null}
      {showSpread && finding.stageId != null ? (
        <StageTaskSpread stageId={finding.stageId} appModel={appModel} getTaskData={getTaskData} idPrefix="straggler" />
      ) : null}
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** Board section for `straggler` findings: a stage where speculative retries fired or a share of
 * tasks ran far longer than the median. */
export const Straggler = defineFindingWidget(stragglerModel, { Row });
