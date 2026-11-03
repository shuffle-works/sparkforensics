import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactDot } from '@/view/ImpactBadge';
import { StageHeader } from '@/view/StageHeader';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { metricLabel, speculationWasteModel, type SpeculationWasteRow } from './SpeculationWaste.rows';

function Row({ row: { finding, stated, note }, appModel }: FindingRowProps<SpeculationWasteRow>) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ImpactDot impactBand={finding.impactBand} />
        {finding.stageId != null ? <StageHeader stageId={finding.stageId} appModel={appModel} stated={stated} /> : null}
        {stated ? null : <strong>{metricLabel(finding)}</strong>}
      </div>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** Executor time spent on speculative task attempts that were ultimately discarded. */
export const SpeculationWaste = defineFindingWidget(speculationWasteModel, { Row });
