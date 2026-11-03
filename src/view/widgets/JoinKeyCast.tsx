import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { joinKeyCastModel, type JoinKeyCastRow } from './JoinKeyCast.rows';

function Row({ row: { finding, stageIds, headline, detail } }: FindingRowProps<JoinKeyCastRow>) {
  return (
    <>
      {stageIds.length > 0 ? <StagePillGroup pills={stageIds.map((id) => ({ id }))} /> : null}
      {headline === null ? null : <p>{headline} <ImpactEstimate finding={finding} /></p>}
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </>
  );
}

/** A shuffled join whose key carries a cast, followed by an exchange on the uncast column. Its
 * sibling is `NestedLoopJoin.tsx`. */
export const JoinKeyCast = defineFindingWidget(joinKeyCastModel, { Row });
