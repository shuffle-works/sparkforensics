import { AdvancedOnly } from '@/view/AdvancedOnly';
import { ImpactDot } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { computeEfficiencyModel } from '@sparkforensics/core/efficiency-model.ts';
import { checkConcurrentJobGroups } from '@sparkforensics/core/job-groups.ts';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { DesignSpikeConfidenceBadge, formatCoreHours } from './design-spike-widget-shared';

export interface EfficiencyModelProps {
  appModel: AppModel;
}

// Efficiency/wastage report + driver-vs-executor right-sizing copy.
// DESIGN SPIKE: framed as an estimate. The right-sizing block is a pure copy
// branch on dominantWaste. The unverified ~21% figure is never rendered.
export function EfficiencyModel({ appModel }: EfficiencyModelProps) {
  if (!appModel.runAggregates) return null;
  const m = computeEfficiencyModel({
    app: appModel.app,
    stages: appModel.stages,
    executorsAdded: appModel.executors.added,
    runAggregates: appModel.runAggregates,
  });
  if (m.availableComputeHours <= 0) return null;

  const reliability = checkConcurrentJobGroups(appModel.jobs);

  let rightSizing = null;
  if (m.dominantWaste === 'driver') {
    rightSizing = (
      <p>
        <strong>Driver-bound waste dominates.</strong> Review driver sizing (spark.driver.memory /
        spark.driver.cores) before scaling executors.
      </p>
    );
  } else if (m.dominantWaste === 'executor') {
    rightSizing = (
      <p>
        <strong>Executor-bound waste dominates.</strong> Review executor count / cores by reducing cluster
        size or enabling dynamic allocation.
      </p>
    );
  }

  return (
    <WidgetCard
      title="Compute Efficiency"
      statusBadge={<DesignSpikeConfidenceBadge />}
      defaultCollapsed
      summary={
        <WidgetLeadSummary
          value={m.wastagePct != null ? `${m.wastagePct}% wasted` : formatCoreHours(m.availableComputeHours)}
          context={`of ${formatCoreHours(m.availableComputeHours)} available`}
        />
      }
    >
      <div className="space-y-2 text-sm">
        {!reliability.wallClockReliable && (
          <AdvancedOnly>
            <p className="text-muted-foreground">
              This run used concurrent job groups: the driver/executor split below is approximate, not
              precise.
            </p>
          </AdvancedOnly>
        )}
        <p>
          Available: <strong>{formatCoreHours(m.availableComputeHours)}</strong>
          {m.wastagePct != null && (
            <>
              {' '}
              · wasted <strong>{m.wastagePct}%</strong>
            </>
          )}
        </p>
        <p>
          <ImpactDot impactBand="info" /> Driver-bound waste: <strong>{formatCoreHours(m.driverWasteHours)}</strong>
        </p>
        <p>
          <ImpactDot impactBand="info" /> Executor-bound waste: <strong>{formatCoreHours(m.executorWasteHours)}</strong>
        </p>
        <p className="text-muted-foreground">
          Floor (same executors, zero skew): {formatDuration(m.floorZeroSkewMs)}
        </p>
        {rightSizing}
      </div>
    </WidgetCard>
  );
}
