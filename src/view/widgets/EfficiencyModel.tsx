import { AdvancedOnly } from '@/view/AdvancedOnly';
import { ImpactDot } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { DESIGN_SPIKE_DISCLAIMER } from '@/view/design-spike-disclaimer';
import { useInterpretation } from '@/view/interpretation';
import { formatDuration, MS_PER_CORE_HOUR } from '@sparkforensics/core/format-utils.ts';

const formatCoreHours = (h: number): string => `${Math.round(h * 100) / 100} core-h`;

// Allocated vs. used core-hours, the waste split into driver- and executor-bound, and
// right-sizing copy. The top-N list ranks stages by task core-time, NOT by waste: per-stage
// waste isn't attributable here because concurrent stages share allocated capacity.
// DESIGN SPIKE: framed as an estimate. The right-sizing block is a pure copy
// branch on dominantWaste. The unverified ~21% figure is never rendered.
export function EfficiencyModel() {
  const interpretation = useInterpretation()?.data;
  const m = interpretation?.efficiency;
  if (!interpretation || !m || m.availableComputeHours <= 0) return null;
  const { usefulCoreHours, totalCores, topStages } = interpretation.wastedCoreHours;

  let rightSizing = null;
  if (m.dominantWaste === 'driver') {
    rightSizing = (
      <p>
        <strong>Most of it is driver waste:</strong> review spark.driver.memory and spark.driver.cores
        before scaling executors.
      </p>
    );
  } else if (m.dominantWaste === 'executor') {
    rightSizing = (
      <p>
        <strong>Most of it is executor waste:</strong> reduce cluster size or enable dynamic allocation.
      </p>
    );
  }

  return (
    <WidgetCard
      title="Compute Efficiency"
      statusBadge={
        <AdvancedOnly>
          <RowStatusCluster confidence="low" validationRequired={DESIGN_SPIKE_DISCLAIMER} />
        </AdvancedOnly>
      }
      defaultCollapsed
      summary={
        <WidgetLeadSummary
          value={m.wastagePct != null ? `${m.wastagePct}% wasted` : formatCoreHours(m.availableComputeHours)}
          context={`of ${formatCoreHours(m.availableComputeHours)} allocated`}
        />
      }
    >
      <div className="space-y-2 text-sm">
        {!interpretation.wallClockReliable && (
          <AdvancedOnly>
            <p className="text-muted-foreground">
              This run used concurrent job groups: the driver/executor split below is approximate, not
              precise.
            </p>
          </AdvancedOnly>
        )}
        <p>
          Allocated: <strong>{formatCoreHours(m.availableComputeHours)}</strong>
          {usefulCoreHours != null && (
            <>
              {' '}
              · Used: <strong>{formatCoreHours(usefulCoreHours)}</strong>
            </>
          )}
          {m.wastagePct != null && (
            <>
              {' '}
              · wasted <strong>{m.wastagePct}%</strong>
            </>
          )}
        </p>
        {totalCores != null && (
          <AdvancedOnly>
            <p className="text-muted-foreground text-xs">
              Allocated = {totalCores} cores over the run; used = core-time that actually ran tasks.
            </p>
          </AdvancedOnly>
        )}
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
        {topStages.length > 0 && (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Top stages by task core-time</p>
            <ul className="space-y-0.5">
              {topStages.map((s) => (
                <li key={s.stageId} className="flex justify-between gap-2">
                  <span>Stage {s.stageId}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatCoreHours(s.coreMs / MS_PER_CORE_HOUR)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
