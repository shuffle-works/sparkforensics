import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { StageHeader } from '@/view/StageHeader';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { gcModel, type GcRow } from './GcPressure.rows';

// GC % = total JVM GC time ÷ total executor run time: it can exceed 100% when
// GC pauses overlap many concurrent task threads.
const GC_NOTE =
  'GC % = total JVM GC time ÷ total executor run time; it can exceed 100% when GC pauses overlap many concurrent task threads.';

function Row({ row: { finding, stageId, stated, showHeader, showStatus, runTime }, appModel }: FindingRowProps<GcRow>) {
  return (
    <>
      {showHeader ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StageHeader stageId={stageId} appModel={appModel} stated={stated} />
          {showStatus ? <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} /> : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {stated ? null : (
          <>
            GC: <strong>{finding.value}%</strong> &middot;{' '}
          </>
        )}
        Executor run time: <strong>{formatDuration(runTime)}</strong>
      </p>
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

const Lead: NonNullable<FindingWidgetView<GcRow>['Lead']> = ({ density }) => (
  density === 'advanced' ? <p className="mb-4 text-xs text-muted-foreground">{GC_NOTE}</p> : null
);

/** Per-stage GC-time board: the two branches the `gc` detector pushes, a "high GC" branch (garbage
 * collection eating an outsized share of executor run time) and a "low GC / cost" branch (executor
 * memory likely over-provisioned), each a section with its own paging. */
export const GcPressure = defineFindingWidget(gcModel, { Row, Lead });
