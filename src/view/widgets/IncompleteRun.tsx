import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { incompleteRunModel, type IncompleteRunRow } from './IncompleteRun.rows';

function Row({ row: { finding } }: FindingRowProps<IncompleteRunRow>) {
  const { recommendation } = finding;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        ApplicationEnd event: <strong>missing</strong>
      </p>
      <ImpactEstimate finding={finding} />
      {recommendation ? <p className="pt-1">{recommendation}</p> : null}
    </>
  );
}

/** No SparkListenerApplicationEnd was recorded, so every other finding and metric on this board
 * reflects only what was captured before the run was cut off. */
export const IncompleteRun = defineFindingWidget(incompleteRunModel, { Row });
