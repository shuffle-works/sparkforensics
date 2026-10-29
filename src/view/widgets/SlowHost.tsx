import { ImpactDot } from '@/view/ImpactBadge';
import { StageHeader } from '@/view/StageHeader';
import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { slowHostModel, type SlowHostRow } from './SlowHost.rows';

function Row({ row: { finding, stated, showIdentity, detail, measurement }, appModel }: FindingRowProps<SlowHostRow>) {
  return (
    <>
      {showIdentity ? (
        <div className="flex flex-wrap items-center gap-2">
          <ImpactDot impactBand={finding.impactBand} />
          {finding.stageId != null ? <StageHeader stageId={finding.stageId} appModel={appModel} stated={stated} /> : null}
        </div>
      ) : null}
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      {measurement ? <p className="text-xs text-muted-foreground">{measurement}</p> : null}
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** Board section for `slowHost` findings: a host or executor doing disproportionate work within a stage. */
export const SlowHost = defineFindingWidget(slowHostModel, { Row });
