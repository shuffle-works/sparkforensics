import { RowStatusCluster } from '@/view/RowStatusCluster';
import { ImpactDot } from '@/view/ImpactBadge';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { CoreUsageChart, useLocalityChartModel } from './CoreUsageArea';
import { memoryUtilizationModel, type MemoryRow } from './MemoryUtilization.rows';

/** The idle-core chart, or the measurements behind the figure. */
function MemoryEvidence({ row: { chart, evidence } }: { row: MemoryRow }) {
  const model = useLocalityChartModel();
  if (chart && model.hasActivity) return <CoreUsageChart model={model} />;
  return evidence === null ? null : <p className="text-xs text-muted-foreground">{evidence}</p>;
}

function Row({ row }: FindingRowProps<MemoryRow>) {
  const { finding, label, stated, note, detail, diagnosis } = row;
  if (note !== null) return <p className="text-muted-foreground">{note}</p>;
  return (
    <>
      <p className="flex flex-wrap items-start gap-2">
        <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
        <strong>{label}</strong>
      </p>
      {stated ? <MemoryEvidence row={row} /> : (
        <p className="text-xs text-muted-foreground">
          {detail}
          {diagnosis}
        </p>
      )}
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

// The confidence/evidence marker sits on the header, not per row: `executorMetrics` evidence is a
// widget-wide constant. A single header-level confidence is claimed only when every measured finding
// shares it; a caveat carries no confidence of its own.
const Status: NonNullable<FindingWidgetView<MemoryRow>['Status']> = ({ rows, density }) => {
  if (density !== 'advanced') return null;
  const measured = rows.filter((row) => !row.caveat).map((row) => row.finding);
  const shared = measured.every((f) => f.confidence === measured[0]?.confidence) ? measured[0] : undefined;
  return <RowStatusCluster confidence={shared?.confidence} validationRequired={shared?.validationRequired} evidenceKey="executorMetrics" />;
};

/** Executor memory utilization. Lists every affected sub-finding: idle cores, per-executor heap
 * bands, and the memory-waste model, never just the worst. */
export const MemoryUtilization = defineFindingWidget(memoryUtilizationModel, { Row, Status });
