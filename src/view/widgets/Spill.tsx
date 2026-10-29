import { formatBytes, numericValue, SPILL_CLASS_SHORT, SPILL_CLASS_TITLE } from '@sparkforensics/core/format-utils.ts';
import { Chip, ImpactDot } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { StagePill } from '@/view/StagePill';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { MemoryPressure } from './MemoryPressure';
import { PartitionHint } from './PartitionHint';
import { PlanExplorer } from './PlanExplorer';
import { spillModel, type SpillRow } from './Spill.rows';

function Row({ row: { finding, stageId, stated, spillClass, diskBytes, evidence, partitionHint, showPlanExplorer, showStatus }, appModel }: FindingRowProps<SpillRow>) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ImpactDot impactBand={finding.impactBand} />
          <Chip label={SPILL_CLASS_SHORT[spillClass]} impactBand={finding.impactBand} title={SPILL_CLASS_TITLE[spillClass]} />
          {stated ? null : <StagePill stageId={stageId} />}
        </div>
        {showStatus ? <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} /> : null}
      </div>
      <p className="text-sm">
        {/* spill's value is always a numeric byte count; the line above an evidence panel states it. */}
        {stated ? null : (
          <>
            Memory spilled: <strong>{formatBytes(numericValue(finding))}</strong>
            {' · '}
          </>
        )}
        Disk: {formatBytes(diskBytes)}
      </p>
      {evidence.length > 0 ? (
        <ul className="space-y-0.5 text-sm text-muted-foreground">
          {evidence.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      {stated ? null : <ImpactEstimate finding={finding} />}
      {partitionHint ? <PartitionHint hint={partitionHint} /> : null}
      {showPlanExplorer ? (
        <div className="pt-1">
          <PlanExplorer stageId={stageId} appModel={appModel} />
        </div>
      ) : null}
    </>
  );
}

const Lead: NonNullable<FindingWidgetView<SpillRow>['Lead']> = ({ appModel }) => (
  <div className="mb-4">
    <MemoryPressure appModel={appModel} />
  </div>
);

/** Memory/disk spill, one row per flagged stage, never just the worst. The skew/volume/unclassified
 * classification is the actionable signal, so it's a plain-text label on every row (not a hover-only
 * tooltip); `SPILL_CLASS_TITLE` only supplies the supplementary `title=` tooltip. A run with no spill
 * finding has no card: the dashboard shows it as a clean check. */
export const Spill = defineFindingWidget(spillModel, { Row, Lead });
