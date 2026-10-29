import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { StagePillGroup } from '@/view/StagePill';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { pythonUdfModel, type PythonUdfRow } from './PythonUdf.rows';

function Row({ row: { finding, headline } }: FindingRowProps<PythonUdfRow>) {
  return (
    <>
      {finding.stageIds.length > 0 ? <StagePillGroup pills={finding.stageIds.map((id) => ({ id }))} /> : null}
      <p>{headline} <ImpactEstimate finding={finding} /></p>
    </>
  );
}

const Status: NonNullable<FindingWidgetView<PythonUdfRow>['Status']> = ({ rows: [{ finding }], density }) => (
  density === 'advanced' ? (
    <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} evidenceKey="sqlPlan" />
  ) : null
);

/** Stages running row-at-a-time Python UDFs that ship every row to a Python worker and back, which
 * Arrow-optimized Python UDFs or a pandas UDF avoid. */
export const PythonUdf = defineFindingWidget(pythonUdfModel, { Row, Status });
