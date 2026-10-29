import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { smallFilesModel, type SmallFilesRow } from './SmallFiles.rows';

function Row({ row: { finding, stageIds, headline, detail } }: FindingRowProps<SmallFilesRow>) {
  return (
    <>
      {stageIds.length > 0 ? <StagePillGroup pills={stageIds.map((id) => ({ id }))} /> : null}
      {headline === null ? null : <p>{headline} <ImpactEstimate finding={finding} /></p>}
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </>
  );
}

// `sqlPlan` is a widget-wide evidence constant (this detector always reads the resolved SQL plan),
// so it sits on the header once, not per row.
const Status: NonNullable<FindingWidgetView<SmallFilesRow>['Status']> = ({ rows: [{ finding }], density }) => (
  density === 'advanced' ? (
    <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} evidenceKey="sqlPlan" />
  ) : null
);

/** A scan reading many small input files, wasting task-scheduling overhead a coalesce/repartition
 * upstream would avoid. */
export const SmallFiles = defineFindingWidget(smallFilesModel, { Row, Status });
