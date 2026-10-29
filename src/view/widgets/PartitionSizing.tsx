import { StageHeader } from '@/view/StageHeader';
import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { PlanExplorer } from './PlanExplorer';
import { partitionSizingModel, type PartitionSizingRow } from './PartitionSizing.rows';

function Row({ row: { stageId, stageStated, rules, showPlanExplorer }, appModel }: FindingRowProps<PartitionSizingRow>) {
  return (
    <>
      <StageHeader stageId={stageId} appModel={appModel} stated={stageStated} />
      {rules.length > 0 || showPlanExplorer ? (
        <div className="space-y-2 pt-1">
          {rules.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {rules.map(({ finding, label }) => (
                <li key={finding.id}>
                  {label}{' '}
                  <ImpactEstimate finding={finding} />
                </li>
              ))}
            </ul>
          ) : null}
          {showPlanExplorer ? <PlanExplorer stageId={stageId} appModel={appModel} /> : null}
        </div>
      ) : null}
    </>
  );
}

/** Partition-sizing recommendations board: flags every stage carrying a `partitionSizing` finding
 * (never just the worst one). */
export const PartitionSizing = defineFindingWidget(partitionSizingModel, { Row });
